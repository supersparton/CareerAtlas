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

  private pipelineStatus = {
    active: false,
    steps: {
      'step-1': { status: 'idle', errorDetails: '' },
      'step-2': { status: 'idle', errorDetails: '' },
      'step-3': { status: 'idle', errorDetails: '' },
      'step-4': { status: 'idle', errorDetails: '' },
      'step-5': { status: 'idle', errorDetails: '' },
      'step-6': { status: 'idle', errorDetails: '' },
      'step-7': { status: 'idle', errorDetails: '' },
    },
    logs: [] as string[],
  };

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

  getPipelineStatus() {
    return this.pipelineStatus;
  }

  private resetPipelineStatus() {
    this.pipelineStatus = {
      active: true,
      steps: {
        'step-1': { status: 'idle', errorDetails: '' },
        'step-2': { status: 'idle', errorDetails: '' },
        'step-3': { status: 'idle', errorDetails: '' },
        'step-4': { status: 'idle', errorDetails: '' },
        'step-5': { status: 'idle', errorDetails: '' },
        'step-6': { status: 'idle', errorDetails: '' },
        'step-7': { status: 'idle', errorDetails: '' },
      },
      logs: [],
    };
  }

  private updateStep(stepId: string, status: 'idle' | 'running' | 'success' | 'error', errorDetails = '') {
    if (this.pipelineStatus.steps[stepId]) {
      this.pipelineStatus.steps[stepId].status = status;
      this.pipelineStatus.steps[stepId].errorDetails = errorDetails;
    }
  }

  private addPipelineLog(msg: string) {
    const timestamp = new Date().toLocaleTimeString();
    this.pipelineStatus.logs.unshift(`[${timestamp}] ${msg}`);
  }

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
  async runWorkflow(searchTerm: string, locationSearch: string, limit = 5): Promise<RankedJob[]> {
    this.logger.log(`[ORCHESTRATOR] --- STARTING PIPELINE WORKFLOW FOR "${searchTerm}" (Target limit: ${limit}) ---`);

    // Fetch candidate profile to get target location/remote preferences for validation
    let profile: UserProfile | null = null;
    try {
      profile = await this.profileService.getProfileById(this.activeUserId);
    } catch (err) {
      this.logger.error(`[ORCHESTRATOR] Failed to load profile for validation: ${err.message}`);
    }

    let page = 1;
    const maxCycles = 3;
    let currentCycle = 1;
    let accumulatedMatches: RankedJob[] = [];

    this.updateStep('step-2', 'running');
    this.addPipelineLog(`[Cycle ${currentCycle}] Scrapers starting search for "${searchTerm}"...`);

    while (accumulatedMatches.length < limit && currentCycle <= maxCycles) {
      this.logger.log(`\n[ORCHESTRATOR] 🔄 [CYCLE ${currentCycle} / ${maxCycles}] Starting parallel job ingestion...`);
      this.addPipelineLog(`[Cycle ${currentCycle}] Crawling LinkedIn and querying TinyFish API...`);

      // 1. Run all discovery agents in parallel
      const [atsJobs, startupJobs, indiaJobs, linkedinJobs] = await Promise.all([
        this.atsPortalsAgent.findJobs(searchTerm, locationSearch, page),
        this.startupBoardsAgent.findJobs(searchTerm, locationSearch, page),
        this.indiaFocusedAgent.findJobs(searchTerm, locationSearch, page),
        this.linkedinAgent.findJobs(searchTerm, locationSearch, page),
      ]);

      const rawScrapedJobs = [...atsJobs, ...startupJobs, ...indiaJobs, ...linkedinJobs];
      this.logger.log(`[ORCHESTRATOR] Ingested ${rawScrapedJobs.length} raw jobs. Sending to Validation Layer...`);
      this.addPipelineLog(`[Cycle ${currentCycle}] Ingested ${rawScrapedJobs.length} raw jobs. Transitioning to Validation Layer...`);

      this.updateStep('step-2', 'success');
      this.updateStep('step-3', 'running');
      this.addPipelineLog(`[Cycle ${currentCycle}] Validation Layer: Deduplicating and testing active URL link status...`);

      // 2. Validation Layer (Duplicates, Expiry, URL, Title, and Location checks)
      const validatedJobs = await this.validationService.validateJobs(rawScrapedJobs, searchTerm, profile);
      this.logger.log(`[ORCHESTRATOR] Validation Layer passed ${validatedJobs.length} / ${rawScrapedJobs.length} jobs.`);
      this.addPipelineLog(`[Cycle ${currentCycle}] Validation Layer passed ${validatedJobs.length} / ${rawScrapedJobs.length} jobs.`);

      this.updateStep('step-3', 'success');

      if (validatedJobs.length === 0) {
        this.logger.warn('[ORCHESTRATOR] No new validated jobs found in this cycle.');
        this.addPipelineLog(`[Cycle ${currentCycle}] No new validated jobs found in this cycle.`);
        page++;
        currentCycle++;
        continue;
      }

      this.updateStep('step-4', 'running');
      this.updateStep('step-5', 'running');
      this.addPipelineLog(`[Cycle ${currentCycle}] Job Intelligence: Extracting structured JDs and generating embeddings for ${validatedJobs.length} jobs...`);

      // 3. Structured Extraction & Embedding Generation & pgvector Insertion (JobIntelligenceService)
      this.logger.log('[ORCHESTRATOR] Processing structured requirements and generating embeddings for validated jobs...');
      const extractionChunkSize = 4;
      for (let i = 0; i < validatedJobs.length; i += extractionChunkSize) {
        const chunk = validatedJobs.slice(i, i + extractionChunkSize);
        const extractionPromises = chunk.map(async (job) => {
          try {
            await this.jobIntelligenceService.processJob(job);
            // Mark as processed in local MemoryService cache
            this.memoryService.markJobAsProcessed(job.company, job.title, job.location, job.source);
          } catch (err) {
            this.logger.error(`[ORCHESTRATOR] Failed to process/embed job ${job.jobId}: ${err.message}`);
          }
        });
        await Promise.all(extractionPromises);
      }

      this.updateStep('step-4', 'success');
      this.updateStep('step-5', 'success');
      this.addPipelineLog(`[Cycle ${currentCycle}] Job Intelligence complete: structured JDs saved and embeddings stored.`);

      this.updateStep('step-6', 'running');
      this.addPipelineLog(`[Cycle ${currentCycle}] Recommendation matching: Running Hard Filters, Skill Normalization Mapping, and pgvector Cosine Match...`);

      // 4. Run Matching & Ranking Engine
      const rankedMatches = await this.matchingService.matchAndRankJobs(this.activeUserId, limit);
      accumulatedMatches = rankedMatches;

      this.updateStep('step-6', 'success');

      this.logger.log(`[ORCHESTRATOR] Cycle ${currentCycle} complete. Matches meeting threshold requirements: ${accumulatedMatches.length}`);
      this.addPipelineLog(`[Cycle ${currentCycle}] Complete. Matches meeting threshold requirements: ${accumulatedMatches.length}`);

      if (accumulatedMatches.length >= limit) {
        break;
      } else {
        page++;
        currentCycle++;
        this.updateStep('step-2', 'running');
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
    userEmail?: string,
    employmentTypes?: string[],
    salaryExpectation?: number | null
  ) {
    this.logger.log('[ORCHESTRATOR] Starting background job recommendation suite...');

    // 1. Resolve active user ID and sync preferences at runtime
    this.resetPipelineStatus();
    this.updateStep('step-1', 'running');
    this.addPipelineLog('Syncing profile details and user embedding with PostgreSQL / Supabase...');

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
          SET locations = EXCLUDED.locations,
              remote = EXCLUDED.remote,
              preferred_roles = EXCLUDED.preferred_roles,
              employment_types = EXCLUDED.employment_types,
              salary_expectation = EXCLUDED.salary_expectation;
        `, [
          resolvedUserId,
          searchTerms,
          [locationPref],
          isRemoteOpen,
          employmentTypes || ['Full-time'],
          salaryExpectation ?? null,
          0
        ]);
        this.logger.log(`[ORCHESTRATOR] Synchronized runtime preferences for User ID ${resolvedUserId}: locations=[${locationPref}], remote=${isRemoteOpen}, employmentTypes=${JSON.stringify(employmentTypes)}, salaryExpectation=${salaryExpectation}`);
        this.addPipelineLog(`Runtime preferences synchronized for User ID ${resolvedUserId}.`);
        this.updateStep('step-1', 'success');
      }
    } catch (err) {
      this.logger.error(`[ORCHESTRATOR] Failed to resolve active user ID and preferences: ${err.message}`);
      this.addPipelineLog(`Failed to sync profile: ${err.message}`);
      this.updateStep('step-1', 'error', err.message);
      this.pipelineStatus.active = false;
      return;
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

      this.updateStep('step-7', 'running');
      this.addPipelineLog('Weighted ranking: Selecting top job matches...');

      // Sort matches by finalScore descending
      const sortedJobs = allMatchedJobs.sort((a, b) => b.finalScore - a.finalScore);
      const topJobs = sortedJobs.slice(0, targetLimit);

      this.logger.log(`[ORCHESTRATOR] Selected top ${topJobs.length} highest-scoring jobs. Triggering notifications...`);
      this.addPipelineLog(`Selected top ${topJobs.length} job matches. Generating AI reasoning & sending alerts...`);

      // Retrieve candidate profile context
      const profileObj = await this.profileService.getProfileById(resolvedUserId);

      for (const match of topJobs) {
        const { job, finalScore, skillScore, semanticScore, experienceScore, reasoning } = match;

        // Skip if already notified/matched in memory
        if (this.memoryService.isJobMatched(job.company, job.title, job.location, job.source)) {
          this.logger.log(`[ORCHESTRATOR] Skipping notification: Job "${job.title}" at "${job.company}" was already notified.`);
          this.addPipelineLog(`Skipping notification: "${job.title}" at "${job.company}" was already notified.`);
          continue;
        }

        // Mark as matched/notified
        this.memoryService.markJobAsMatched(job.company, job.title, job.location, job.source);

        // Generate personalized LLM reasoning explanation
        let aiReasoning = reasoning;
        if (profileObj) {
          try {
            const reasoningPrompt = `
              You are an expert career agent. Write a concise, 2-sentence explanation of why the following job is a great match for the candidate.
              
              Job Details:
              - Title: ${job.title}
              - Company: ${job.company}
              - Location: ${job.location}
              
              Candidate Profile:
              - Name: ${profileObj.fullName}
              - Skills: ${profileObj.skills.join(', ')}
              - Experience: ${profileObj.experienceYears} years
              
              Explain the match clearly and professionally, highlighting the candidate's skills and projects that align.
              Do not include any greeting or conversational fluff. Write exactly 2 sentences.
            `;
            const response = await this.profileService.invokeModel(reasoningPrompt);
            if (response && response.trim()) {
              aiReasoning = response.trim();
            }
          } catch (reasonErr) {
            this.logger.warn(`Failed to generate LLM reasoning for job ${job.jobId}: ${reasonErr.message}`);
          }
        }

        // Trigger Application Agent (Telegram Notifier)
        await this.notifierService.sendJobAlert(
          job,
          finalScore,
          {
            skills: skillScore,
            experience: experienceScore,
            location: Math.round(semanticScore),
          },
          aiReasoning
        );
        this.addPipelineLog(`Telegram alert sent successfully for "${job.title}" at ${job.company}.`);
      }

      this.updateStep('step-7', 'success');
      this.addPipelineLog('Background recommendation suite workflow finished.');
      this.logger.log('[ORCHESTRATOR] Background recommendation suite workflow finished.');
      this.pipelineStatus.active = false;
    } catch (err) {
      this.logger.error(`[ORCHESTRATOR] Ingestion workflow suite failed: ${err.message}`, err.stack);
      this.addPipelineLog(`Workflow suite failed: ${err.message}`);
      
      // Mark running steps as error
      for (const key of Object.keys(this.pipelineStatus.steps)) {
        if (this.pipelineStatus.steps[key].status === 'running') {
          this.updateStep(key, 'error', err.message);
        }
      }
      this.pipelineStatus.active = false;
    }
  }
}
