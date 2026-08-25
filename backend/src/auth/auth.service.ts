import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { MemoryService } from '../memory/memory.service';
import { DatabaseService } from '../vector-store/database.service';
import { MailService } from './mail.service';
import * as crypto from 'crypto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly memoryService: MemoryService,
    private readonly databaseService: DatabaseService,
    private readonly mailService: MailService,
  ) {}

  private get redis() {
    return this.memoryService.getRedisClient();
  }

  private normalizeEmail(email?: string): string {
    if (!email || typeof email !== 'string') return '';
    return email.toLowerCase().trim();
  }

  async sendOtp(rawEmail: string): Promise<{ success: boolean; message: string; expiresInSeconds: number }> {
    const email = this.normalizeEmail(rawEmail);

    if (!email || !email.includes('@')) {
      throw new HttpException('A valid email address is required.', HttpStatus.BAD_REQUEST);
    }

    if (this.redis) {
      // 1. Check lockout status (10-minute lock)
      const isLocked = await this.redis.get(`otp:lockout:${email}`);
      if (isLocked) {
        throw new HttpException('Too many failed attempts. Account temporarily locked for 10 minutes.', HttpStatus.TOO_MANY_REQUESTS);
      }

      // 2. Check 20-minute request rate limit (max 3 requests)
      const now = Date.now();
      const windowMs = 20 * 60 * 1000;
      const rawRequests = await this.redis.lrange(`otp:requests:${email}`, 0, -1);
      const validRequests = rawRequests
        .map((t) => parseInt(t, 10))
        .filter((t) => now - t < windowMs);

      if (validRequests.length >= 3) {
        throw new HttpException('OTP request limit exceeded. Maximum 3 OTP requests allowed every 20 minutes.', HttpStatus.TOO_MANY_REQUESTS);
      }

      await this.redis.rpush(`otp:requests:${email}`, String(now));
      await this.redis.expire(`otp:requests:${email}`, 1200);
    }

    // 3. Generate 6-digit numeric OTP
    const otp = crypto.randomInt(100000, 1000000).toString();

    // 4. Store Salted + Peppered OTP Hash in Redis (5 min TTL = 300s)
    if (this.redis) {
      const salt = crypto.randomBytes(16).toString('hex');
      const hashedOtp = this.hashOtpWithSalt(otp, salt);
      const payload = JSON.stringify({ hash: hashedOtp, salt });

      await this.redis.set(`otp:code:${email}`, payload, 'EX', 300);
      await this.redis.del(`otp:failed_attempts:${email}`);
    }

    // 5. Send via Google SMTP
    await this.mailService.sendOtpEmail(email, otp);
    this.logger.log(`[AUTH] Sent 6-digit OTP (Hashed with Salt+Pepper in Redis) to ${email}`);

    return {
      success: true,
      message: 'Verification code sent to your email.',
      expiresInSeconds: 300,
    };
  }

  private getPepperSecret(): string {
    const pepper = process.env.PEPPER_SECRET || process.env.OTP_PEPPER_SECRET;
    if (!pepper) {
      throw new Error('[AUTH] PEPPER_SECRET or OTP_PEPPER_SECRET environment variable is required. Set it in your .env file.');
    }
    return pepper;
  }

  private hashOtpWithSalt(otp: string, salt: string): string {
    const pepper = this.getPepperSecret();
    return crypto.createHmac('sha256', pepper).update(otp + salt).digest('hex');
  }

  async verifyOtp(rawEmail: string, submittedOtp: string): Promise<{ success: boolean; message: string; user: any; token: string; isFirstTime?: boolean; expiresAt?: string }> {
    const email = this.normalizeEmail(rawEmail);
    const cleanOtp = submittedOtp ? submittedOtp.trim() : '';

    if (!email || !cleanOtp) {
      throw new HttpException('Email and verification code are required.', HttpStatus.BAD_REQUEST);
    }

    if (this.redis) {
      const isLocked = await this.redis.get(`otp:lockout:${email}`);
      if (isLocked) {
        throw new HttpException('Too many failed attempts. Account temporarily locked for 10 minutes.', HttpStatus.TOO_MANY_REQUESTS);
      }

      const storedPayload = await this.redis.get(`otp:code:${email}`);
      if (!storedPayload) {
        throw new HttpException('OTP expired or invalid. Please request a new code.', HttpStatus.BAD_REQUEST);
      }

      let isMatch = false;
      try {
        if (storedPayload.startsWith('{')) {
          const { hash: storedHash, salt } = JSON.parse(storedPayload);
          const submittedHash = this.hashOtpWithSalt(cleanOtp, salt);
          const storedBuf = Buffer.from(storedHash, 'hex');
          const submittedBuf = Buffer.from(submittedHash, 'hex');
          isMatch = storedBuf.length === submittedBuf.length && crypto.timingSafeEqual(storedBuf, submittedBuf);
        } else {
          // Backward compatibility: timing-safe comparison for legacy plaintext OTPs
          const storedBuf = Buffer.from(storedPayload, 'utf8');
          const submittedBuf = Buffer.from(cleanOtp, 'utf8');
          isMatch = storedBuf.length === submittedBuf.length && crypto.timingSafeEqual(storedBuf, submittedBuf);
        }
      } catch (err) {
        isMatch = false;
      }

      if (!isMatch) {
        const attempts = await this.redis.incr(`otp:failed_attempts:${email}`);
        await this.redis.expire(`otp:failed_attempts:${email}`, 300);

        if (attempts >= 3) {
          await this.redis.set(`otp:lockout:${email}`, 'locked', 'EX', 600); // 10 min lock
          await this.redis.del(`otp:code:${email}`);
          await this.redis.del(`otp:failed_attempts:${email}`);
          throw new HttpException('Too many failed attempts. Account temporarily locked for 10 minutes.', HttpStatus.TOO_MANY_REQUESTS);
        }

        const remaining = 3 - attempts;
        throw new HttpException(`Invalid verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`, HttpStatus.BAD_REQUEST);
      }

      await this.redis.del(`otp:code:${email}`);
      await this.redis.del(`otp:failed_attempts:${email}`);
    }

    let user: any = null;
    let isFirstTime = false;
    try {
      const existingUserRes = await this.databaseService.query('SELECT id, email, created_at, last_login_at FROM users WHERE email = $1', [email]);
      if (existingUserRes.rows.length > 0) {
        user = existingUserRes.rows[0];
        isFirstTime = !user.last_login_at;
        await this.databaseService.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
      } else {
        isFirstTime = true;
        const newUserRes = await this.databaseService.query(
          'INSERT INTO users (email, full_name, created_at, last_login_at) VALUES ($1, $2, NOW(), NOW()) RETURNING id, email, created_at',
          [email, email.split('@')[0]]
        );
        user = newUserRes.rows[0];
      }
    } catch (err: any) {
      this.logger.error(`[AUTH] DB user sync failed: ${err.message}`);
      throw new HttpException('Unable to authenticate. Database error during user lookup.', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // Generate secure session token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    try {
      await this.databaseService.query(
        'INSERT INTO sessions (user_id, email, session_token, expires_at) VALUES ($1, $2, $3, $4)',
        [user.id, email, token, expiresAt]
      );
    } catch (err: any) {
      this.logger.error(`[AUTH] DB session save failed: ${err.message}`);
    }

    if (this.redis) {
      try {
        const sessionData = JSON.stringify({ userId: user.id, email, expiresAt: expiresAt.toISOString(), isFirstTime });
        await this.redis.set(`session:${token}`, sessionData, 'EX', 7 * 86400); // 7 days TTL
      } catch (err: any) {
        this.logger.error(`[AUTH] Redis session save failed: ${err.message}`);
      }
    }

    this.logger.log(`[AUTH] Successfully verified OTP for ${email} (isFirstTime: ${isFirstTime})`);
    return {
      success: true,
      message: 'Login successful.',
      user,
      isFirstTime,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async validateSession(token: string): Promise<{ valid: boolean; message?: string; user?: any; isFirstTime?: boolean }> {
    if (!token || token.trim() === '') {
      return { valid: false, message: 'No session token provided.' };
    }

    const cleanToken = token.trim();

    // 1. Check Redis fast cache
    if (this.redis) {
      try {
        const cached = await this.redis.get(`session:${cleanToken}`);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (new Date(parsed.expiresAt) > new Date()) {
            return { valid: true, user: { id: parsed.userId, email: parsed.email }, isFirstTime: !!parsed.isFirstTime };
          }
        }
      } catch (err: any) {
        this.logger.error(`[AUTH] Redis session check failed: ${err.message}`);
      }
    }

    // 2. Fallback to PostgreSQL DB check
    try {
      const res = await this.databaseService.query(
        'SELECT s.user_id, s.email, s.expires_at, u.created_at, u.last_login_at FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.session_token = $1',
        [cleanToken]
      );

      if (res.rows.length === 0) {
        return { valid: false, message: 'Invalid session token.' };
      }

      const session = res.rows[0];
      if (new Date(session.expires_at) <= new Date()) {
        await this.databaseService.query('DELETE FROM sessions WHERE session_token = $1', [cleanToken]);
        if (this.redis) await this.redis.del(`session:${cleanToken}`);
        return { valid: false, message: 'Session expired.' };
      }

      return {
        valid: true,
        user: { id: session.user_id, email: session.email },
        isFirstTime: !session.last_login_at,
      };
    } catch (err: any) {
      this.logger.error(`[AUTH] DB session validation failed: ${err.message}`);
      return { valid: false, message: 'Session validation error.' };
    }
  }

  async logout(token: string): Promise<{ success: boolean; message: string }> {
    if (!token) return { success: true, message: 'Logged out.' };

    const cleanToken = token.trim();
    let redisDeleted = false;
    let dbDeleted = false;

    if (this.redis) {
      try {
        const result = await this.redis.del(`session:${cleanToken}`);
        redisDeleted = result > 0;
      } catch (err: any) {
        this.logger.error(`[AUTH] Redis session delete failed: ${err.message}`);
      }
    }

    try {
      const res = await this.databaseService.query('DELETE FROM sessions WHERE session_token = $1', [cleanToken]);
      dbDeleted = (res.rowCount ?? 0) > 0;
    } catch (err: any) {
      this.logger.error(`[AUTH] DB session delete failed: ${err.message}`);
    }

    if (!redisDeleted && !dbDeleted) {
      this.logger.debug(`[AUTH] Session ${cleanToken.slice(0, 8)}... was not found in Redis or DB during logout (already expired or invalid)`);
    }

    return { success: true, message: 'Logged out successfully.' };
  }
}
