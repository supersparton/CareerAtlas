import { Controller, Post, Get, Body, Headers, Req, Res, HttpCode, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SendOtpDto, VerifyOtpDto } from './auth.dto';
import { Request, Response } from 'express';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('send-otp')
  @HttpCode(HttpStatus.OK)
  async sendOtp(@Body() dto: SendOtpDto) {
    return this.authService.sendOtp(dto.email);
  }

  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  async verifyOtp(@Body() dto: VerifyOtpDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.authService.verifyOtp(dto.email, dto.otp);
    
    // Set HTTP-Only Cookie for session persistence
    response.cookie('careeratlas_session', result.token, {
      httpOnly: true,
      secure: false, // Local HTTP support
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    return result;
  }

  private extractToken(req: Request, authHeader?: string): string | undefined {
    if (req.cookies?.['careeratlas_session']) {
      return req.cookies['careeratlas_session'];
    }
    if (req.headers.cookie) {
      const match = req.headers.cookie.match(/careeratlas_session=([^;]+)/);
      if (match) return match[1];
    }
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    return undefined;
  }

  @Get('session')
  async getSession(@Req() req: Request, @Headers('authorization') authHeader?: string) {
    const token = this.extractToken(req, authHeader);
    const result = await this.authService.validateSession(token || '');
    if (!result.valid) {
      throw new UnauthorizedException(result.message || 'Session expired or invalid.');
    }
    return result;
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: Request, @Res({ passthrough: true }) response: Response, @Headers('authorization') authHeader?: string) {
    const token = this.extractToken(req, authHeader);
    response.clearCookie('careeratlas_session', {
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
    });
    return this.authService.logout(token || '');
  }
}
