import { Controller, Post, Get, Body, HttpCode, HttpStatus, Logger, Query } from '@nestjs/common';
import { AgentService } from './agent.service';

export interface StartWorkflowDto {
  searchTerms: string[];
  locationPreference: string;
  isRemoteOpen: boolean;
  userEmail?: string;
  employmentTypes?: string[];
  salaryExpectation?: number;
}

@Controller('api')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly agentService: AgentService,
  ) {}

  @Get('agent/status')
  getAgentStatus() {
    return this.agentService.getPipelineStatus();
  }

  @Get('agent/results')
  async getAgentResults(@Query('email') email?: string) {
    return this.agentService.getWorkflowResults(email);
  }

  // Trigger the job search scraper workflow in the background
  @Post('agent/run')
  @HttpCode(HttpStatus.ACCEPTED)
  async runAgent(@Body() body: StartWorkflowDto): Promise<{ message: string; searchTerms: string[] }> {
    if (!body.searchTerms || !Array.isArray(body.searchTerms) || body.searchTerms.length === 0) {
      throw new Error('At least one search title must be specified.');
    }

    const searchTerms = body.searchTerms;
    const locationPref = body.locationPreference || 'Remote';
    const isRemoteOpen = body.isRemoteOpen ?? true;
    const userEmail = body.userEmail;
    const employmentTypes = body.employmentTypes || ['Full-time'];
    const salaryExpectation = body.salaryExpectation !== undefined ? body.salaryExpectation : null;

    let locationSearch = `"${locationPref}"`;
    if (isRemoteOpen && locationPref.toLowerCase() !== 'remote') {
      locationSearch = `("${locationPref}" OR "Remote")`;
    } else if (locationPref.toLowerCase() === 'remote') {
      locationSearch = '"Remote"';
    }

    this.logger.log(`[API] Triggering workflow asynchronously for: ${JSON.stringify(searchTerms)} in ${locationSearch} for user: ${userEmail || 'default'}`);

    // Trigger run in the background via runWorkflowSuite
    (async () => {
      try {
        await this.agentService.runWorkflowSuite(
          searchTerms,
          locationSearch,
          locationPref,
          isRemoteOpen,
          userEmail,
          employmentTypes,
          salaryExpectation,
        );
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
