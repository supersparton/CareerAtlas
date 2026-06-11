import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AtsPortalsAgent } from '../discovery/ats-portals.agent';
import { StartupBoardsAgent } from '../discovery/startup-boards.agent';
import { IndiaFocusedAgent } from '../discovery/india-focused.agent';
import { LinkedInAgent } from '../discovery/linkedin.agent';
import { MemoryService } from '../memory/memory.service';
import { NotifierService } from '../notifier/notifier.service';
import { Job } from '../discovery/discovery.service';
import { ProfileService, UserProfile } from '../profile/profile.service';
import { ValidationService } from '../validation/validation.service';
import { JobIntelligenceService } from '../intelligence/job-intelligence.service';
import { MatchingService, RankedJob } from '../matching/matching.service';
import { DatabaseService } from '../vector-store/database.service';

@Injectable()
export class AgentService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgentService.name);
  private activeUserId = 1; // Default user ID for single-user environment

  constructor(
    private readonly atsPortalsAgent: AtsPortalsAgent,
    private readonly startupBoardsAgent: StartupBoardsAgent,
    private readonly indiaFocusedAgent: IndiaFocusedAgent,
    private readonly linkedinAgent: LinkedInAgent,
    private readonly memoryService: MemoryService,
    private readonly notifierService: NotifierService,
    private readonly profileService: ProfileService,
    private readonly validationService: ValidationService,
    private readonly jobIntelligenceService: JobIntelligenceService,
    private readonly matchingService: MatchingService,
    private readonly db: DatabaseService,
  ) {}

  async onApplicationBootstrap() {
    this.logger.log('[ORCHESTRATOR] Agent Bootstrapped. Syncing initial profile.json with database...');
    try {
      const fileProfile = this.profileService.getProfile();
      if (fileProfile && fileProfile.email) {
        // Sync the profile from profile.json to PostgreSQL
        const mappedProfile: UserProfile = {
          fullName: fileProfile.fullName,
          email: fileProfile.email,
          phone: fileProfile.phone,
          skills: fileProfile.coreSkills || [],
          experienceYears: fileProfile.experienceLevel.toLowerCase().includes('senior') 
            ? 6 
            : fileProfile.experienceLevel.toLowerCase().includes('mid') 
              ? 3 
              : 1, // Map string level to years
          education: fileProfile.education ? fileProfile.education.map(e => `${e.degree} at ${e.institution}`) : [],
          projects: fileProfile.projects ? fileProfile.projects.map(p => `${p.title}: ${p.description}`) : [],
          achievements: [],
          preferredRoles: [fileProfile.targetRole],
          preferences: {
            locations: [fileProfile.targetLocation],
            remote: fileProfile.isRemoteOpen,
            employmentTypes: ['Full-time'],
          },
        };
        const saved = await this.profileService.saveProfileToDb(mappedProfile);
        this.activeUserId = saved.id || 1;
        this.logger.log(`[ORCHESTRATOR] Profile synchronized to DB successfully. Active User ID: ${this.activeUserId}`);
      } else {
        this.logger.warn('[ORCHESTRATOR] No active profile found in profile.json to sync. Waiting for resume upload.');
      }
    } catch (err) {
      this.logger.error(`[ORCHESTRATOR] Failed to sync profile.json to database on startup: ${err.message}`);
    }
  }

  /**
   * Main workflow execution
   */
  async runWorkflow(searchTerm: string, locationPref: string, limit = 5): Promise<RankedJob[]> {
    this.logger.log(`[ORCHESTRATOR] --- STARTING PIPELINE WORKFLOW FOR "${searchTerm}" (Target limit: ${limit}) ---`);

    let page = 1;
    const maxCycles = 3;
    let currentCycle = 1;
    let accumulatedMatches: RankedJob[] = [];

    while (accumulatedMatches.length < limit && currentCycle <= maxCycles) {
      this.logger.log(`\n[ORCHESTRATOR] 🔄 [CYCLE ${currentCycle} / ${maxCycles}] Starting parallel job ingestion...`);

      // 1. Run all discovery agents in parallel
      const [atsJobs, startupJobs, indiaJobs, linkedinJobs] = await Promise.all([
        this.atsPortalsAgent.findJobs(searchTerm, locationPref, page),
        this.startupBoardsAgent.findJobs(searchTerm, locationPref, page),
        this.indiaFocusedAgent.findJobs(searchTerm, locationPref, page),
        this.linkedinAgent.findJobs(searchTerm, locationPref, page),
      ]);

      const rawScrapedJobs = [...atsJobs, ...startupJobs, ...indiaJobs, ...linkedinJobs];
      this.logger.log(`[ORCHESTRATOR] Ingested ${rawScrapedJobs.length} raw jobs. Sending to Validation Layer...`);

      // 2. Validation Layer (Duplicates, Expiry, URL check)
      const validatedJobs = await this.validationService.validateJobs(rawScrapedJobs);
      this.logger.log(`[ORCHESTRATOR] Validation Layer passed ${validatedJobs.length} / ${rawScrapedJobs.length} jobs.`);

      if (validatedJobs.length === 0) {
        this.logger.warn('[ORCHESTRATOR] No new validated jobs found in this cycle.');
        page++;
        currentCycle++;
        continue;
      }

      // 3. Structured Extraction & Embedding Generation & pgvector Insertion (JobIntelligenceService)
      this.logger.log('[ORCHESTRATOR] Processing structured requirements and generating embeddings for validated jobs...');
      const extractionPromises = validatedJobs.map(async (job) => {
        try {
          await this.jobIntelligenceService.processJob(job);
          // Mark as processed in local MemoryService cache
          this.memoryService.markJobAsProcessed(job.company, job.title, job.location, job.source);
        } catch (err) {
          this.logger.error(`[ORCHESTRATOR] Failed to process/embed job ${job.jobId}: ${err.message}`);
        }
      });
      await Promise.all(extractionPromises);

      // 4. Run Matching & Ranking Engine
      const rankedMatches = await this.matchingService.matchAndRankJobs(this.activeUserId, limit);
      accumulatedMatches = rankedMatches;

      this.logger.log(`[ORCHESTRATOR] Cycle ${currentCycle} complete. Matches meeting threshold requirements: ${accumulatedMatches.length}`);

      if (accumulatedMatches.length >= limit) {
        break;
      } else {
        page++;
        currentCycle++;
      }
    }

    return accumulatedMatches;
  }

  /**
   * Main suite runner triggered in the background
   */
  async runWorkflowSuite(
    searchTerms: string[],
    locationSearch: string,
    locationPref: string,
    isRemoteOpen: boolean,
    userEmail?: string
  ) {
    this.logger.log('[ORCHESTRATOR] Starting background job recommendation suite...');

    // 1. Resolve active user ID and sync preferences at runtime
    let resolvedUserId = this.activeUserId;
    try {
      let userRes;
      if (userEmail) {
        userRes = await this.db.query('SELECT id FROM users WHERE email = $1', [userEmail.trim().toLowerCase()]);
      }
      if (!userRes || userRes.rows.length === 0) {
        userRes = await this.db.query('SELECT id FROM users ORDER BY id DESC LIMIT 1');
      }
      if (userRes && userRes.rows.length > 0) {
        resolvedUserId = userRes.rows[0].id;
        this.activeUserId = resolvedUserId;

        // Upsert preferences to match runtime location & remote settings
        await this.db.query(`
          INSERT INTO user_preferences (user_id, preferred_roles, locations, remote, employment_types, salary_expectation, experience_years)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (user_id) DO UPDATE
          SET locations = EXCLUDED.locations, remote = EXCLUDED.remote, preferred_roles = EXCLUDED.preferred_roles;
        `, [
          resolvedUserId,
          searchTerms,
          [locationPref],
          isRemoteOpen,
          ['Full-time'],
          null, // Let it stay null/empty unless already set
          0
        ]);
        this.logger.log(`[ORCHESTRATOR] Synchronized runtime preferences for User ID ${resolvedUserId}: locations=[${locationPref}], remote=${isRemoteOpen}`);
      }
    } catch (err) {
      this.logger.error(`[ORCHESTRATOR] Failed to resolve active user ID and preferences: ${err.message}`);
    }

    try {
      const targetLimit = 5;
      const allMatchedJobs: RankedJob[] = [];

      for (const term of searchTerms) {
        if (allMatchedJobs.length >= targetLimit) {
          break;
        }
        const matches = await this.runWorkflow(term, locationSearch, targetLimit - allMatchedJobs.length);
        allMatchedJobs.push(...matches);
      }

      // Sort matches by finalScore descending
      const sortedJobs = allMatchedJobs.sort((a, b) => b.finalScore - a.finalScore);
      const topJobs = sortedJobs.slice(0, targetLimit);

      this.logger.log(`[ORCHESTRATOR] Selected top ${topJobs.length} highest-scoring jobs. Triggering notifications...`);

      for (const match of topJobs) {
        const { job, finalScore, skillScore, semanticScore, experienceScore, reasoning } = match;

        // Skip if already notified/matched in memory
        if (this.memoryService.isJobMatched(job.company, job.title, job.location, job.source)) {
          continue;
        }

        // Mark as matched/notified
        this.memoryService.markJobAsMatched(job.company, job.title, job.location, job.source);

        // Trigger Application Agent (Telegram Notifier)
        await this.notifierService.sendJobAlert(
          job,
          finalScore,
          {
            skills: skillScore,
            experience: experienceScore,
            location: Math.round(semanticScore), // Map semantic similarity score as sub-score
          },
          reasoning
        );
      }

      this.logger.log('[ORCHESTRATOR] Background recommendation suite workflow finished.');
    } catch (err) {
      this.logger.error(`[ORCHESTRATOR] Ingestion workflow suite failed: ${err.message}`, err.stack);
    }
  }
}
