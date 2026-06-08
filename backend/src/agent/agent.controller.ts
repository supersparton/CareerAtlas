import { Controller, Post, Get, Body, UploadedFile, UseInterceptors, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ProfileService } from './profile.service';
import type { ParsedProfile } from './profile.service';
import { AgentService } from './agent.service';

export interface StartWorkflowDto {
  searchTerms: string[];
  locationPreference: string;
  isRemoteOpen: boolean;
}

@Controller('api')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly profileService: ProfileService,
    private readonly agentService: AgentService,
  ) {}

  @Post('profile/upload-resume')
  @UseInterceptors(FileInterceptor('file'))
  async uploadResume(
    @UploadedFile()
    file: {
      originalname: string;
      mimetype: string;
      size: number;
      buffer: Buffer;
    },
  ): Promise<ParsedProfile> {
    if (!file) {
      throw new Error('No resume file was uploaded.');
    }
    if (file.mimetype !== 'application/pdf') {
      throw new Error('Only PDF resume files are accepted.');
    }
    this.logger.log(`[API] Received resume file "${file.originalname}" (${file.size} bytes)`);
    return this.profileService.parseResumePdf(file.buffer);
  }

  // 2. Get current profile data
  @Get('profile')
  getProfile(): ParsedProfile {
    return this.profileService.getProfile();
  }

  // 3. Get LLM recommended search terms/job titles based on profile
  @Get('profile/suggest-titles')
  async suggestTitles(): Promise<{ searchTerms: string[] }> {
    const searchTerms = await this.profileService.suggestJobTitles();
    return { searchTerms };
  }

  // 4. Confirm titles and trigger the job search scraper workflow in the background
  @Post('agent/run')
  @HttpCode(HttpStatus.ACCEPTED)
  async runAgent(@Body() body: StartWorkflowDto): Promise<{ message: string; searchTerms: string[] }> {
    if (!body.searchTerms || !Array.isArray(body.searchTerms) || body.searchTerms.length === 0) {
      throw new Error('At least one search title must be specified.');
    }

    const searchTerms = body.searchTerms;
    const locationPref = body.locationPreference || 'Remote';
    const isRemoteOpen = body.isRemoteOpen ?? true;

    // Build the query parameter logic (similar to how AgentService processed location)
    let locationSearch = `"${locationPref}"`;
    if (isRemoteOpen && locationPref.toLowerCase() !== 'remote') {
      locationSearch = `("${locationPref}" OR "Remote")`;
    } else if (locationPref.toLowerCase() === 'remote') {
      locationSearch = '"Remote"';
    }

    this.logger.log(`[API] Triggering workflow asynchronously for: ${JSON.stringify(searchTerms)} in ${locationSearch}`);

    // Trigger run in the background via runWorkflowSuite
    (async () => {
      try {
        await this.agentService.runWorkflowSuite(searchTerms, locationSearch);
        this.logger.log('[BACKGROUND AGENT] Finished all run cycles.');
      } catch (err) {
        this.logger.error('[BACKGROUND AGENT] Run failed', err);
      }
    })();

    return {
      message: 'Job search workflow triggered in the background.',
      searchTerms,
    };
  }
}
