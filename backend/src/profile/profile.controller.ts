import { Controller, Post, Get, Patch, Delete, Body, UploadedFile, UseInterceptors, HttpCode, HttpStatus, Logger, Query, Param, Sse, MessageEvent, Req, Headers } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ProfileService, UserProfile } from './profile.service';
import { AuthService } from '../auth/auth.service';
import { Observable, interval, merge } from 'rxjs';
import { map, filter } from 'rxjs/operators';

export interface StartWorkflowDto {
  searchTerms: string[];
  locationPreference: string;
  isRemoteOpen: boolean;
  userEmail?: string;
}

@Controller('api/profile')
export class ProfileController {
  private readonly logger = new Logger(ProfileController.name);

  constructor(
    private readonly profileService: ProfileService,
    private readonly authService: AuthService,
  ) {}

  private extractToken(req?: any, authHeader?: string): string | undefined {
    if (req?.cookies?.['careeratlas_session']) {
      return req.cookies['careeratlas_session'];
    }
    if (req?.headers?.cookie) {
      const match = req.headers.cookie.match(/careeratlas_session=([^;]+)/);
      if (match) return match[1];
    }
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    return undefined;
  }

  private async resolveUser(req?: any, authHeader?: string, emailQuery?: string): Promise<{ id: number; email: string } | null> {
    const token = this.extractToken(req, authHeader);
    if (token) {
      try {
        const session = await this.authService.validateSession(token);
        if (session.valid && session.user) {
          return session.user;
        }
      } catch (err: any) {
        this.logger.warn(`[PROFILE API] Token validation error: ${err.message}`);
      }
    }
    if (emailQuery && emailQuery.trim() !== '') {
      const pool = (this.profileService as any).db.getPool();
      const userRes = await pool.query('SELECT id, email FROM users WHERE LOWER(email) = LOWER($1)', [emailQuery.trim()]);
      if (userRes.rows.length > 0) {
        return { id: userRes.rows[0].id, email: userRes.rows[0].email };
      }
    }
    // Fallback: latest user in DB
    const pool = (this.profileService as any).db.getPool();
    const usersRes = await pool.query('SELECT id, email FROM users ORDER BY id DESC LIMIT 1');
    if (usersRes.rows.length > 0) {
      return { id: usersRes.rows[0].id, email: usersRes.rows[0].email };
    }
    return null;
  }

  @Post('upload-resume')
  @UseInterceptors(FileInterceptor('file'))
  async uploadResume(
    @UploadedFile()
    file: {
      originalname: string;
      mimetype: string;
      size: number;
      buffer: Buffer;
    },
    @Body('versionName') customVersionName?: string,
    @Body('userEmail') bodyEmail?: string,
    @Req() req?: any,
    @Headers('authorization') authHeader?: string,
  ): Promise<{ success: boolean; taskId: string }> {
    if (!file) {
      throw new Error('No resume file was uploaded.');
    }
    if (file.size > 10 * 1024 * 1024) {
      throw new Error('File size exceeds the maximum allowed limit of 10MB.');
    }
    if (file.mimetype !== 'application/pdf' && !file.originalname.toLowerCase().endsWith('.pdf')) {
      throw new Error('Only PDF resume files are accepted.');
    }

    // Verify PDF Magic Bytes (%PDF- / 0x25 0x50 0x44 0x46)
    if (!file.buffer || file.buffer.length < 4 || file.buffer.toString('utf8', 0, 4) !== '%PDF') {
      throw new Error('Invalid file format. The uploaded file is not a valid PDF document.');
    }

    const authUser = await this.resolveUser(req, authHeader, bodyEmail);
    const targetUserEmail = authUser?.email || bodyEmail;

    const taskId = 'parse_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString().slice(-4);
    this.logger.log(`[API] Received resume file "${file.originalname}" for user "${targetUserEmail || 'unknown'}". Assigned taskId: ${taskId}`);
    
    // Spawn parsing job in the background asynchronously with user association
    this.profileService.runBackgroundParse(taskId, file.buffer, file.originalname, customVersionName, targetUserEmail);
    
    return { success: true, taskId };
  }

  @Sse('parse-status/:taskId')
  parseStatus(@Param('taskId') taskId: string): Observable<MessageEvent> {
    this.logger.log(`[API] Client subscribing to SSE parse stream for taskId: ${taskId}`);
    
    const heartbeats = interval(15000).pipe(
      map(() => ({
        data: {
          status: 'ping',
          log: 'ping',
        }
      } as MessageEvent))
    );

    const events = this.profileService.getTaskEventStream(taskId).pipe(
      filter(event => event.taskId === taskId),
      map(event => ({
        data: {
          status: event.status,
          log: event.log,
          errorDetails: event.errorDetails,
          profile: event.profile,
        }
      } as MessageEvent))
    );

    return merge(events, heartbeats);
  }

  @Get()
  async getProfile(
    @Query('email') email?: string,
    @Req() req?: any,
    @Headers('authorization') authHeader?: string,
  ): Promise<UserProfile> {
    const user = await this.resolveUser(req, authHeader, email);
    let profile: UserProfile | null = null;
    
    if (user) {
      profile = await this.profileService.getProfileById(user.id);
    }

    if (!profile) {
      return {
        fullName: 'No Resume Uploaded',
        email: user?.email || '',
        skills: [],
        experienceYears: 0,
        education: [],
        projects: [],
        achievements: [],
        preferredRoles: [],
        preferences: {
          locations: [],
          remote: true,
          employmentTypes: [],
        },
      };
    }

    return profile;
  }

  @Get('versions')
  async getVersions(
    @Query('email') email?: string,
    @Req() req?: any,
    @Headers('authorization') authHeader?: string,
  ): Promise<any[]> {
    const user = await this.resolveUser(req, authHeader, email);
    if (!user) return [];
    return this.profileService.getUserVersions(user.id);
  }

  @Post('versions/:id/activate')
  async activateVersion(
    @Param('id') id: string,
    @Query('email') email?: string,
    @Req() req?: any,
    @Headers('authorization') authHeader?: string,
  ): Promise<{ success: boolean; profile?: UserProfile }> {
    const user = await this.resolveUser(req, authHeader, email);
    if (!user) throw new Error('User profile not found.');
    const activated = await this.profileService.activateResumeVersion(user.id, parseInt(id, 10));
    return { success: !!activated, profile: activated || undefined };
  }

  @Patch('versions/:id')
  async renameVersion(
    @Param('id') id: string,
    @Body('versionName') versionName: string,
    @Query('email') email?: string,
    @Req() req?: any,
    @Headers('authorization') authHeader?: string,
  ): Promise<{ success: boolean }> {
    const user = await this.resolveUser(req, authHeader, email);
    if (!user) throw new Error('User profile not found.');
    const ok = await this.profileService.renameResumeVersion(user.id, parseInt(id, 10), versionName);
    return { success: ok };
  }

  @Delete('versions/:id')
  async deleteVersion(
    @Param('id') id: string,
    @Query('email') email?: string,
    @Req() req?: any,
    @Headers('authorization') authHeader?: string,
  ): Promise<{ success: boolean }> {
    const user = await this.resolveUser(req, authHeader, email);
    if (!user) throw new Error('User profile not found.');
    const ok = await this.profileService.deleteResumeVersion(user.id, parseInt(id, 10));
    return { success: ok };
  }

  @Get('suggest-titles')
  async suggestTitles(
    @Query('email') email?: string,
    @Req() req?: any,
    @Headers('authorization') authHeader?: string,
  ): Promise<{ searchTerms: string[] }> {
    const user = await this.resolveUser(req, authHeader, email);
    const profile = user ? await this.profileService.getProfileById(user.id) : null;
    if (!profile || !profile.email) {
      return { searchTerms: ['Software Engineer'] };
    }
    const searchTerms = await this.profileService.suggestJobTitles(profile);
    return { searchTerms: searchTerms.length > 0 ? searchTerms : ['Software Engineer'] };
  }
}
