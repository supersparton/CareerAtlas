import { Controller, Post, Get, Body, HttpCode, HttpStatus, Logger, Query, Param, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AgentService } from './agent.service';

export interface StartWorkflowDto {
  searchTerms: string[];
  locationPreference: string;
  isRemoteOpen: boolean;
  userEmail?: string;
  employmentTypes?: string[];
}

@Controller('api')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly agentService: AgentService,
  ) {}

  @Get('agent/status')
  async getAgentStatus(@Query('runId') runId?: string) {
    return await this.agentService.getPipelineStatus(runId);
  }

  @Get('agent/results')
  async getAgentResults(@Query('email') email?: string) {
    return this.agentService.getWorkflowResults(email);
  }

  @Get('agent/history')
  async getSearchHistory(
    @Query('email') email?: string,
    @Query('versionId') versionId?: string,
  ) {
    const vId = versionId ? parseInt(versionId, 10) : undefined;
    return this.agentService.getSearchHistory(email, vId);
  }

  @Get('agent/history/:sessionId')
  async getSessionResults(
    @Param('sessionId') sessionId: string,
    @Query('email') email?: string,
  ) {
    return this.agentService.getSessionResults(parseInt(sessionId, 10), email);
  }

  // Trigger the job search scraper workflow in the background
  @Post('agent/run')
  @HttpCode(HttpStatus.ACCEPTED)
  async runAgent(@Body() body: StartWorkflowDto): Promise<{ message: string; runId: string; searchTerms: string[] }> {
    if (!body.searchTerms || !Array.isArray(body.searchTerms) || body.searchTerms.length === 0) {
      throw new BadRequestException('At least one search title must be specified.');
    }

    const searchTerms = body.searchTerms;
    const locationPref = body.locationPreference || 'Remote';
    const isRemoteOpen = body.isRemoteOpen ?? true;
    const userEmail = body.userEmail;
    const employmentTypes = body.employmentTypes || ['Full-time'];

    let locationSearch = `"${locationPref}"`;
    if (isRemoteOpen && locationPref.toLowerCase() !== 'remote') {
      locationSearch = `("${locationPref}" OR "Remote")`;
    } else if (locationPref.toLowerCase() === 'remote') {
      locationSearch = '"Remote"';
    }

    this.logger.log(`[API] Triggering workflow asynchronously for: ${JSON.stringify(searchTerms)} in ${locationSearch} for user: ${userEmail || 'default'}`);

    const runId = await this.agentService.startWorkflowRun(
      searchTerms,
      locationSearch,
      locationPref,
      isRemoteOpen,
      userEmail,
      employmentTypes,
    );

    return {
      message: 'Job search workflow triggered in the background.',
      runId,
      searchTerms,
    };
  }

  @Post('agent/clear')
  @HttpCode(HttpStatus.OK)
  async clearHistory(@Body('email') email?: string) {
    if (!email || email.trim() === '') {
      throw new BadRequestException('Email is required to clear history.');
    }
    await this.agentService.clearHistory(email);
    return { message: 'History and cache successfully cleared.' };
  }
}
