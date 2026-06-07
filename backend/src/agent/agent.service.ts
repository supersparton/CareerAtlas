import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AtsPortalsAgent } from '../discovery/ats-portals.agent';
import { StartupBoardsAgent } from '../discovery/startup-boards.agent';
import { IndiaFocusedAgent } from '../discovery/india-focused.agent';
import { LinkedInAgent } from '../discovery/linkedin.agent';
import { IntelligenceService } from '../intelligence/intelligence.service';
import { MemoryService } from '../memory/memory.service';
import { NotifierService } from '../notifier/notifier.service';
import { Job } from '../discovery/discovery.service';
import { ProfileParser, UserProfile } from './profile.parser';
import * as path from 'path';

@Injectable()
export class AgentService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgentService.name);
  private userProfile: UserProfile;

  constructor(
    private readonly atsPortalsAgent: AtsPortalsAgent,
    private readonly startupBoardsAgent: StartupBoardsAgent,
    private readonly indiaFocusedAgent: IndiaFocusedAgent,
    private readonly linkedinAgent: LinkedInAgent,
    private readonly intelligenceService: IntelligenceService,
    private readonly memoryService: MemoryService,
    private readonly notifierService: NotifierService,
  ) {}

  private loadProfile() {
    try {
      const profilePath = path.join(process.cwd(), '..', 'profile.txt');
      this.userProfile = ProfileParser.parse(profilePath);
      this.logger.log(`[ORCHESTRATOR] Loaded profile. Target role: "${this.userProfile.targetRole}", Location: "${this.userProfile.targetLocation}"`);
    } catch (e) {
      this.logger.error('[ORCHESTRATOR] Failed to load profile.txt. Using defaults.', e);
      this.userProfile = {
        targetRole: 'Backend Software Engineer',
        coreSkills: ['Node.js', 'TypeScript', 'FastAPI', 'Python'],
        experienceLevel: 'Junior',
        preferences: 'Remote',
        targetLocation: 'Remote',
        isRemoteOpen: true,
      };
    }
  }

  async onApplicationBootstrap() {
    this.logger.log('[ORCHESTRATOR] Agent Bootstrapped. Starting Ingestion & ReAct Loop...');
    this.loadProfile();

    const primaryRole = this.userProfile.targetRole.split(/ or | and |\/|,/i)[0]?.trim() || 'Backend Software Engineer';
    
    let locationSearch = `"${this.userProfile.targetLocation}"`;
    if (this.userProfile.isRemoteOpen && this.userProfile.targetLocation.toLowerCase() !== 'remote') {
      locationSearch = `("${this.userProfile.targetLocation}" OR "Remote")`;
    } else if (this.userProfile.targetLocation.toLowerCase() === 'remote') {
      locationSearch = '"Remote"';
    }

    this.logger.log(`[ORCHESTRATOR] Optimized parameters: Role: "${primaryRole}", Location query: ${locationSearch}`);
    await this.runWorkflow(primaryRole, locationSearch);
  }

  async runWorkflow(searchTerm: string, locationPref: string) {
    this.logger.log('[ORCHESTRATOR] --- STARTING JOB HUNT WORKFLOW ---');

    let page = 1;
    const threshold = 5;
    const maxCycles = 3;
    let currentCycle = 1;
    const acceptedJobs: (Job & { score: number; reasoning: string })[] = [];

    while (acceptedJobs.length < threshold && currentCycle <= maxCycles) {
      this.logger.log(`\n[ORCHESTRATOR] 🔄 [CYCLE ${currentCycle} / ${maxCycles}] Starting parallel ingestion (Threshold: ${threshold}, Found: ${acceptedJobs.length})...`);

      // 1. Run all four discovery agents in parallel
      const [atsJobs, startupJobs, indiaJobs, linkedinJobs] = await Promise.all([
        this.atsPortalsAgent.findJobs(searchTerm, locationPref, page),
        this.startupBoardsAgent.findJobs(searchTerm, locationPref, page),
        this.indiaFocusedAgent.findJobs(searchTerm, locationPref, page),
        this.linkedinAgent.findJobs(searchTerm, locationPref, page),
      ]);

      const allJobs = [...atsJobs, ...startupJobs, ...indiaJobs, ...linkedinJobs];
      this.logger.log(`[ORCHESTRATOR] Scraped ${allJobs.length} total jobs from all agents (ATS: ${atsJobs.length}, Startup Boards: ${startupJobs.length}, India Focused: ${indiaJobs.length}, LinkedIn: ${linkedinJobs.length})`);

      // 2. Deduplicate within the current batch and memory cache
      const uniqueNewJobs: Job[] = [];
      const seenInThisBatch = new Set<string>();

      for (const job of allJobs) {
        // Unique batch key based on company, title, location
        const uniqueKey = `${job.company.toLowerCase().trim()}|${job.title.toLowerCase().trim()}|${job.location.toLowerCase().trim()}`;
        
        if (seenInThisBatch.has(uniqueKey)) {
          continue;
        }
        seenInThisBatch.add(uniqueKey);

        // 3. Skip if already processed (LLM Cache Check)
        if (this.memoryService.isJobProcessed(job.company, job.title, job.location, job.source)) {
          continue;
        }

        uniqueNewJobs.push(job);
      }

      this.logger.log(`[ORCHESTRATOR] Filtered out duplicates. ${uniqueNewJobs.length} new/unseen jobs remaining for analysis.`);

      // 4. Filter and score remaining jobs
      for (const job of uniqueNewJobs) {
        const evaluation = await this.intelligenceService.scoreJob(job);

        // Mark job as processed immediately to prevent repeating LLM queries (Cache)
        this.memoryService.markJobAsProcessed(job.company, job.title, job.location, job.source);

        if (evaluation.isFakeOrSpam) {
          this.logger.warn(`[ORCHESTRATOR] 🚩 Rejected: "${job.title}" at "${job.company}" - Flagged as fake/spam.`);
          continue;
        }

        if (evaluation.finalScore < 60) {
          this.logger.log(`[ORCHESTRATOR] 🔻 Rejected: "${job.title}" at "${job.company}" - Low match score (${evaluation.finalScore}/100)`);
          continue;
        }

        // Override with cleaned/actual company and location from the LLM
        if (evaluation.actualCompany) {
          job.company = evaluation.actualCompany;
        }
        if (evaluation.actualLocation) {
          job.location = evaluation.actualLocation;
        }

        // Success! High quality match
        if (this.memoryService.isJobMatched(job.company, job.title, job.location, job.source)) {
          this.logger.log(`[ORCHESTRATOR] 🔔 Skipped notification: "${job.title}" at "${job.company}" already notified in a previous run.`);
          continue;
        }

        this.logger.log(`[ORCHESTRATOR] 🎯 HIGH MATCH ACCEPTED: "${job.title}" at "${job.company}" (Score: ${evaluation.finalScore}/100)`);
        this.logger.log(`[ORCHESTRATOR] Reasoning: ${evaluation.reasoning}`);
        
        acceptedJobs.push({
          ...job,
          score: evaluation.finalScore,
          reasoning: evaluation.reasoning,
        });

        // Mark as matched in the persistent match storage (seen_jobs.json)
        this.memoryService.markJobAsMatched(job.company, job.title, job.location, job.source);

        // Send Telegram alert with detailed sub-scores
        await this.notifierService.sendJobAlert(
          job,
          evaluation.finalScore,
          {
            skills: evaluation.skillsScore,
            experience: evaluation.experienceScore,
            location: evaluation.locationScore,
          },
          evaluation.reasoning
        );
      }

      this.logger.log(`[ORCHESTRATOR] [CYCLE ${currentCycle}] Ended with ${acceptedJobs.length} accumulated matches.`);

      // 5. ReAct Loop condition check
      if (acceptedJobs.length >= threshold) {
        this.logger.log(`[ORCHESTRATOR] ✅ Threshold reached! Found ${acceptedJobs.length} jobs (Minimum required: ${threshold}). Terminating loop.`);
        break;
      } else {
        this.logger.warn(`[ORCHESTRATOR] ⚠️ Under Threshold! Found only ${acceptedJobs.length} jobs. Max limit is ${threshold}. Incrementing page and looping...`);
        page++;
        currentCycle++;
      }
    }

    this.logger.log('\n[ORCHESTRATOR] --- WORKFLOW COMPLETE ---');
    this.logger.log(`[ORCHESTRATOR] Total high-match jobs found and notified: ${acceptedJobs.length}`);
  }
}
