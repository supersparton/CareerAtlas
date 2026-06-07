import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, ScrapedJob } from '../discovery/discovery.service';
import { CareerPagesAgent } from '../discovery/career-pages.agent';
import { YcGreenhouseAgent } from '../discovery/yc-greenhouse.agent';
import { WellfoundGlassdoorAgent } from '../discovery/wellfound-glassdoor.agent';
import { LinkedInAgent } from '../discovery/linkedin.agent';
import { IntelligenceService } from '../intelligence/intelligence.service';
import { MemoryService } from '../memory/memory.service';
import { NotifierService } from '../notifier/notifier.service';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class AgentService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly careerPagesAgent: CareerPagesAgent,
    private readonly ycGreenhouseAgent: YcGreenhouseAgent,
    private readonly wellfoundGlassdoorAgent: WellfoundGlassdoorAgent,
    private readonly linkedinAgent: LinkedInAgent,
    private readonly intelligenceService: IntelligenceService,
    private readonly memoryService: MemoryService,
    private readonly notifierService: NotifierService,
  ) {}

  private loadProfileDetails() {
    try {
      const profilePath = path.join(process.cwd(), '..', 'profile.txt');
      if (fs.existsSync(profilePath)) {
        const content = fs.readFileSync(profilePath, 'utf-8');
        const targetRoleMatch = content.match(/\[TARGET ROLE\]\r?\n([^\n]+)/i);
        const preferencesMatch = content.match(/\[PREFERENCES\]\r?\n([^\n]+)/i);
        return {
          targetRole: targetRoleMatch ? targetRoleMatch[1].trim() : 'Backend Software Engineer',
          preferences: preferencesMatch ? preferencesMatch[1].trim() : 'Remote',
        };
      }
    } catch (e) {
      this.logger.error('Failed to load profile details in AgentService, using defaults', e);
    }
    return {
      targetRole: 'Backend Software Engineer',
      preferences: 'Remote',
    };
  }

  async onApplicationBootstrap() {
    this.logger.log('Agent Bootstrapped. Starting Ingestion & ReAct Loop...');
    const { targetRole, preferences } = this.loadProfileDetails();
    this.logger.log(`Parsed profile - Role: "${targetRole}", Preferences/Location: "${preferences}"`);

    // Clean and optimize search queries
    const primaryRole = targetRole.split(/ or | and |\/|,/i)[0]?.trim() || 'Backend Software Engineer';
    
    // Smart location preference parsing
    let locationSearch = 'Remote';
    const segments = preferences.split(',').map(s => s.trim());
    const excludeKeywords = /remote|hybrid|onsite|on-site|office|startup|developer|engineer|no\b|roles\b|job\b|work\b/i;
    const locationSegment = segments.find(seg => !excludeKeywords.test(seg));

    if (locationSegment) {
      locationSearch = locationSegment;
    } else if (/remote/i.test(preferences)) {
      locationSearch = 'Remote';
    } else {
      locationSearch = 'US';
    }

    this.logger.log(`Optimized search parameters - Query Role: "${primaryRole}", Query Location: "${locationSearch}"`);
    await this.runWorkflow(primaryRole, locationSearch);
  }

  async runWorkflow(searchTerm: string, locationPref: string) {
    this.logger.log('--- STARTING JOB HUNT WORKFLOW ---');

    let page = 1;
    const threshold = 5; // Minimum number of high-match jobs we want for MVP
    const maxCycles = 3;
    let currentCycle = 1;
    const acceptedJobs: (ScrapedJob & { score: number; reasoning: string })[] = [];

    while (acceptedJobs.length < threshold && currentCycle <= maxCycles) {
      this.logger.log(`\n🔄 [CYCLE ${currentCycle} / ${maxCycles}] Starting parallel ingestion (Threshold: ${threshold}, Found: ${acceptedJobs.length})...`);

      // 1. Run all four discovery agents in parallel
      const [careerJobs, ycJobs, wellfoundJobs, linkedinJobs] = await Promise.all([
        this.careerPagesAgent.findJobs(searchTerm, locationPref, page),
        this.ycGreenhouseAgent.findJobs(searchTerm, locationPref, page),
        this.wellfoundGlassdoorAgent.findJobs(searchTerm, locationPref, page),
        this.linkedinAgent.findJobs(searchTerm, locationPref, page),
      ]);

      const allJobs = [...careerJobs, ...ycJobs, ...wellfoundJobs, ...linkedinJobs];
      this.logger.log(`[CYCLE ${currentCycle}] Scraped ${allJobs.length} total jobs from all agents (Career: ${careerJobs.length}, YC/Greenhouse: ${ycJobs.length}, Wellfound/Glassdoor: ${wellfoundJobs.length}, LinkedIn: ${linkedinJobs.length})`);

      // 2. Deduplicate based on title and company
      const uniqueNewJobs: ScrapedJob[] = [];
      const seenInThisBatch = new Set<string>();

      for (const job of allJobs) {
        const uniqueKey = `${job.title.toLowerCase().trim()}|${job.company.toLowerCase().trim()}`;
        
        // Skip duplicate listings within the current batch
        if (seenInThisBatch.has(uniqueKey)) {
          continue;
        }
        seenInThisBatch.add(uniqueKey);

        // 3. Skip if already processed in any previous cycle or run (Shared Persistent Memory)
        if (this.memoryService.isJobSeen(job.title, job.company)) {
          this.logger.log(`⏭️ Skipped duplicate: [${job.title} at ${job.company}] - Already in persistent memory.`);
          continue;
        }

        uniqueNewJobs.push(job);
      }

      this.logger.log(`[CYCLE ${currentCycle}] Filtered out duplicates. ${uniqueNewJobs.length} new/unseen jobs remaining.`);

      // 4. Filter and score remaining jobs
      for (const job of uniqueNewJobs) {
        this.logger.log(`Evaluating: [${job.title} at ${job.company}]`);
        const evaluation = await this.intelligenceService.scoreJob(job.title, job.company, job.descriptionSnippet);

        // Mark job as seen immediately so we never evaluate it again in future cycles/runs (Shared Memory)
        this.memoryService.markJobAsSeen(job.title, job.company);

        if (evaluation.isFakeOrSpam) {
          this.logger.warn(`🚩 Rejected: [${job.title} at ${job.company}] - Flagged as fake/spam.`);
          continue;
        }

        if (evaluation.matchScore < 60) {
          this.logger.log(`🔻 Rejected: [${job.title} at ${job.company}] - Low match score (${evaluation.matchScore}/100)`);
          continue;
        }

        // Success! High quality match
        this.logger.log(`🎯 HIGH MATCH ACCEPTED: [${job.title} at ${job.company}] (Score: ${evaluation.matchScore}/100)`);
        this.logger.log(`Reasoning: ${evaluation.reasoning}`);
        
        acceptedJobs.push({
          ...job,
          score: evaluation.matchScore,
          reasoning: evaluation.reasoning,
        });

        // Send Telegram alert
        await this.notifierService.sendJobAlert(
          job.title,
          job.company,
          evaluation.matchScore,
          evaluation.reasoning,
          job.url
        );
      }

      this.logger.log(`[CYCLE ${currentCycle}] Ended with ${acceptedJobs.length} accumulated matches.`);

      // 5. ReAct Loop condition check
      if (acceptedJobs.length >= threshold) {
        this.logger.log(`✅ Threshold reached! Found ${acceptedJobs.length} jobs (Minimum required: ${threshold}). Terminating loop.`);
        break;
      } else {
        this.logger.warn(`⚠️ Under Threshold! Found only ${acceptedJobs.length} jobs. Max limit is ${threshold}. Incrementing page and looping...`);
        page++;
        currentCycle++;
      }
    }

    this.logger.log(`\n--- WORKFLOW COMPLETE ---`);
    this.logger.log(`Total high-match jobs found and notified: ${acceptedJobs.length}`);
  }
}

