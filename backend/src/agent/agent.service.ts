import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AtsPortalsAgent } from '../discovery/ats-portals.agent';
import { StartupBoardsAgent } from '../discovery/startup-boards.agent';
import { IndiaFocusedAgent } from '../discovery/india-focused.agent';
import { LinkedInAgent } from '../discovery/linkedin.agent';
import { IntelligenceService } from '../intelligence/intelligence.service';
import { MemoryService } from '../memory/memory.service';
import { NotifierService } from '../notifier/notifier.service';
import { Job } from '../discovery/discovery.service';
import { ProfileService, ParsedProfile as UserProfile } from './profile.service';
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
    private readonly profileService: ProfileService,
  ) {}

  private loadProfile() {
    try {
      this.userProfile = this.profileService.getProfile();
      this.logger.log(`[ORCHESTRATOR] Loaded profile. Target role: "${this.userProfile.targetRole}", Location: "${this.userProfile.targetLocation}"`);
    } catch (e) {
      this.logger.error('[ORCHESTRATOR] Failed to load profile. Using defaults.', e);
      this.userProfile = {
        fullName: 'Default User',
        email: '',
        phone: '',
        targetRole: 'Backend Software Engineer',
        coreSkills: ['Node.js', 'TypeScript', 'FastAPI', 'Python'],
        experienceLevel: 'Junior',
        preferences: 'Remote',
        targetLocation: 'Remote',
        isRemoteOpen: true,
        experience: [],
        projects: [],
        education: [],
      };
    }
  }

  async onApplicationBootstrap() {
    this.logger.log('[ORCHESTRATOR] Agent Bootstrapped in standby mode. Ready to receive upload-resume and agent-run requests.');
    this.loadProfile();
  }

  async runWorkflow(searchTerm: string, locationPref: string, threshold = 5): Promise<(Job & { score: number; reasoning: string; evaluation: any })[]> {
    this.logger.log(`[ORCHESTRATOR] --- STARTING JOB HUNT WORKFLOW FOR "${searchTerm}" (Threshold: ${threshold}) ---`);

    let page = 1;
    const maxCycles = 3;
    let currentCycle = 1;
    const acceptedJobs: (Job & { score: number; reasoning: string; evaluation: any })[] = [];

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

      // 4. Filter and score remaining jobs in parallel
      const scoringPromises = uniqueNewJobs.map(async (job) => {
        try {
          const evaluation = await this.intelligenceService.scoreJob(job, this.userProfile, locationPref);
          return { job, evaluation, success: true };
        } catch (err) {
          this.logger.error(`[ORCHESTRATOR] Error evaluating job "${job.title}" at "${job.company}": ${err.message}`);
          return { job, evaluation: null, success: false };
        }
      });

      const evaluatedResults = await Promise.all(scoringPromises);

      for (const res of evaluatedResults) {
        if (!res.success || !res.evaluation) {
          continue;
        }
        const { job, evaluation } = res;

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
          this.logger.log(`[ORCHESTRATOR] 🔔 Skipped: "${job.title}" at "${job.company}" already matched in a previous run.`);
          continue;
        }

        this.logger.log(`[ORCHESTRATOR] 🎯 HIGH MATCH ACCEPTED: "${job.title}" at "${job.company}" (Score: ${evaluation.finalScore}/100)`);
        this.logger.log(`[ORCHESTRATOR] Reasoning: ${evaluation.reasoning}`);
        
        acceptedJobs.push({
          ...job,
          score: evaluation.finalScore,
          reasoning: evaluation.reasoning,
          evaluation,
        });
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
    this.logger.log(`[ORCHESTRATOR] Total high-match jobs found for "${searchTerm}": ${acceptedJobs.length}`);
    return acceptedJobs;
  }

  async runWorkflowSuite(searchTerms: string[], locationPref: string) {
    this.logger.log('[ORCHESTRATOR] Starting background job search suite...');
    try {
      const targetThreshold = 5;
      const allMatchedJobs: (Job & { score: number; reasoning: string; evaluation: any })[] = [];

      for (const term of searchTerms) {
        if (allMatchedJobs.length >= targetThreshold) {
          this.logger.log(`[ORCHESTRATOR] Overall target threshold of ${targetThreshold} jobs already reached. Skipping remaining search term: "${term}"`);
          break;
        }
        
        this.logger.log(`[ORCHESTRATOR] Running search cycle for term: "${term}" (Target remaining: ${targetThreshold - allMatchedJobs.length})`);
        const matches = await this.runWorkflow(term, locationPref, targetThreshold - allMatchedJobs.length);
        allMatchedJobs.push(...matches);
      }

      this.logger.log(`[ORCHESTRATOR] Finished all search cycles. Total matches found: ${allMatchedJobs.length}`);

      // Sort matches by score descending
      const sortedJobs = allMatchedJobs.sort((a, b) => b.score - a.score);

      // Take top 5
      const topJobs = sortedJobs.slice(0, targetThreshold);
      this.logger.log(`[ORCHESTRATOR] Selecting top ${topJobs.length} highest-rated jobs for notifications...`);

      for (const matched of topJobs) {
        const { score, evaluation, reasoning, ...job } = matched;

        // Mark as matched in the persistent match storage (seen_jobs.json)
        this.memoryService.markJobAsMatched(job.company, job.title, job.location, job.source);

        // Send Telegram alert
        await this.notifierService.sendJobAlert(
          job,
          score,
          {
            skills: evaluation.skillsScore,
            experience: evaluation.experienceScore,
            location: evaluation.locationScore,
          },
          reasoning
        );
      }

      this.logger.log(`[ORCHESTRATOR] Notifications successfully sent for the top ${topJobs.length} matches.`);
    } catch (err) {
      this.logger.error(`[ORCHESTRATOR] Suite run failed: ${err.message}`, err.stack);
    }
  }
}
