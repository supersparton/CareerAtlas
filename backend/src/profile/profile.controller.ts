import { Controller, Post, Get, Body, UploadedFile, UseInterceptors, HttpCode, HttpStatus, Logger, Query } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ProfileService, UserProfile } from './profile.service';

export interface StartWorkflowDto {
  searchTerms: string[];
  locationPreference: string;
  isRemoteOpen: boolean;
  userEmail?: string;
}

@Controller('api/profile')
export class ProfileController {
  private readonly logger = new Logger(ProfileController.name);

  constructor(private readonly profileService: ProfileService) {}

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
  ): Promise<UserProfile> {
    if (!file) {
      throw new Error('No resume file was uploaded.');
    }
    if (file.mimetype !== 'application/pdf') {
      throw new Error('Only PDF resume files are accepted.');
    }
    this.logger.log(`[API] Received resume file "${file.originalname}" (${file.size} bytes)`);
    return this.profileService.parseResumePdf(file.buffer);
  }

  @Get()
  async getProfile(@Query('email') email?: string): Promise<UserProfile> {
    let profile: UserProfile | null = null;
    
    if (email) {
      profile = await this.profileService.getProfileByEmail(email);
    } else {
      // Fallback: get first profile in DB for backward compatibility
      const res = await this.profileService.getProfileById(1); // Check ID 1
      if (res) {
        profile = res;
      } else {
        // Find any user
        const pool = (this.profileService as any).db.getPool();
        const usersRes = await pool.query('SELECT id FROM users LIMIT 1');
        if (usersRes.rows.length > 0) {
          profile = await this.profileService.getProfileById(usersRes.rows[0].id);
        }
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
      return { searchTerms: ['Backend Engineer', 'Software Developer'] };
    }
    const searchTerms = await this.profileService.suggestJobTitles(profile);
    return { searchTerms };
  }
}
