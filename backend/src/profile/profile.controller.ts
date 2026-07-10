import { Controller, Post, Get, Delete, Body, UploadedFile, UseInterceptors, HttpCode, HttpStatus, Logger, Query, Param, Sse, MessageEvent, Res } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ProfileService, UserProfile } from './profile.service';
import { ResumeOptimizerService } from './resume-optimizer.service';
import { ResumesService } from './resumes.service';
import { PdfExportService } from './pdf-export.service';
import { Observable } from 'rxjs';
import { map, filter } from 'rxjs/operators';
import { Response } from 'express';

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
    private readonly resumeOptimizerService: ResumeOptimizerService,
    private readonly resumesService: ResumesService,
    private readonly pdfExportService: PdfExportService,
  ) {}

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
  ): Promise<{ success: boolean; taskId: string }> {
    if (!file) {
      throw new Error('No resume file was uploaded.');
    }
    if (file.mimetype !== 'application/pdf') {
      throw new Error('Only PDF resume files are accepted.');
    }
    const taskId = 'parse_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString().slice(-4);
    this.logger.log(`[API] Received resume file "${file.originalname}" (${file.size} bytes). Assigned background taskId: ${taskId}`);
    
    // Spawn parsing job in the background asynchronously
    this.profileService.runBackgroundParse(taskId, file.buffer);
    
    return { success: true, taskId };
  }

  @Sse('parse-status/:taskId')
  parseStatus(@Param('taskId') taskId: string): Observable<MessageEvent> {
    this.logger.log(`[API] Client subscribing to SSE parse stream for taskId: ${taskId}`);
    return this.profileService.getTaskEventStream(taskId).pipe(
      filter(event => event.taskId === taskId),
      map(event => ({
        data: {
          status: event.status,
          log: event.log,
          errorDetails: event.errorDetails,
          profile: event.profile,
        }
      }))
    );
  }

  @Get()
  async getProfile(@Query('email') email?: string): Promise<UserProfile> {
    let profile: UserProfile | null = null;
    
    if (email) {
      profile = await this.profileService.getProfileByEmail(email);
    } else {
      // Fallback: get the latest profile in DB to handle newly uploaded resumes correctly
      const pool = (this.profileService as any).db.getPool();
      const usersRes = await pool.query('SELECT id FROM users ORDER BY id DESC LIMIT 1');
      if (usersRes.rows.length > 0) {
        profile = await this.profileService.getProfileById(usersRes.rows[0].id);
      }
    }

    if (!profile) {
      return {
        fullName: 'No Resume Uploaded',
        email: '',
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

  @Get('suggest-titles')
  async suggestTitles(@Query('email') email?: string): Promise<{ searchTerms: string[] }> {
    const profile = await this.getProfile(email);
    if (!profile.email) {
      return { searchTerms: ['Software Engineer'] };
    }
    const searchTerms = await this.profileService.suggestJobTitles(profile);
    const limitedTerms = searchTerms.slice(0, 1);
    return { searchTerms: limitedTerms.length > 0 ? limitedTerms : ['Software Engineer'] };
  }

  @Post('optimize')
  async optimize(
    @Body() body: { email: string; jobId: string }
  ): Promise<{ report: any; optimizedResumeData: any }> {
    const user = await this.profileService.getProfileByEmail(body.email);
    if (!user || !user.id) {
      throw new Error(`Profile not found for email: ${body.email}`);
    }
    return this.resumeOptimizerService.optimizeResume(user.id, body.jobId);
  }

  @Get('versions')
  async listVersions(@Query('email') email: string): Promise<any[]> {
    const user = await this.profileService.getProfileByEmail(email);
    if (!user || !user.id) {
      return [];
    }
    return this.resumesService.listVersions(user.id);
  }

  @Get('versions/:id')
  async getVersionDetails(@Param('id') id: string): Promise<any> {
    return this.resumesService.getResumeDetails(Number(id));
  }

  @Post('save-version')
  async saveVersion(
    @Body() body: { email: string; name: string; resumeData: any; sourceType: string; jobId?: string; notes?: string }
  ): Promise<any> {
    const user = await this.profileService.getProfileByEmail(body.email);
    if (!user || !user.id) {
      throw new Error(`Profile not found for email: ${body.email}`);
    }
    return this.resumesService.saveVersion(user.id, body.name, body.resumeData, body.sourceType, body.jobId, body.notes);
  }

  @Post('versions/:id/promote')
  async promoteVersion(@Param('id') id: string, @Body() body: { email: string }): Promise<{ success: boolean }> {
    const user = await this.profileService.getProfileByEmail(body.email);
    if (!user || !user.id) {
      throw new Error(`Profile not found for email: ${body.email}`);
    }
    const success = await this.resumesService.promoteToDefault(user.id, Number(id));
    return { success };
  }

  @Delete('versions/:id')
  async deleteVersion(@Param('id') id: string, @Query('email') email: string): Promise<{ success: boolean }> {
    const user = await this.profileService.getProfileByEmail(email);
    if (!user || !user.id) {
      throw new Error(`Profile not found for email: ${email}`);
    }
    const success = await this.resumesService.deleteVersion(user.id, Number(id));
    return { success };
  }

  @Get('versions/:id/download')
  async downloadPdf(@Param('id') id: string, @Res() res: any): Promise<void> {
    const details = await this.resumesService.getResumeDetails(Number(id));
    if (!details) {
      res.status(HttpStatus.NOT_FOUND).send('Resume version not found');
      return;
    }
    const pdfBuffer = await this.pdfExportService.generatePdf(details);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${details.name.replace(/\s+/g, '_')}.pdf"`);
    res.send(pdfBuffer);
  }
}
