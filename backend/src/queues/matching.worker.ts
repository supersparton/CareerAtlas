import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Queue, Job as BullJob } from 'bullmq';
import { Logger } from '@nestjs/common';
import { MatchingService } from '../matching/matching.service';
import { ProfileService } from '../profile/profile.service';

import { NotifierService } from '../notifier/notifier.service';
import { PipelineCoordinatorService } from './pipeline-coordinator.service';
import { DatabaseService } from '../vector-store/database.service';

interface MatchingJobPayload {
  runId: string;
  userId: number;
  searchTerms: string[];
  activeTermIndex: number;
  locationSearch: string;
  limit: number;
  currentCycle: number;
  maxCycles: number;
  page: number;
  accumulatedMatches: any[];
}

@Processor('job-matching', { concurrency: 2 })
export class MatchingWorker extends WorkerHost {
  private readonly logger = new Logger(MatchingWorker.name);

  constructor(
    private readonly matchingService: MatchingService,
    private readonly profileService: ProfileService,
    private readonly notifierService: NotifierService,
    private readonly coordinator: PipelineCoordinatorService,
    private readonly db: DatabaseService,
    @InjectQueue('job-discovery') private readonly discoveryQueue: Queue,
  ) {
    super();
  }

  async process(bullJob: BullJob<MatchingJobPayload>): Promise<any> {
    const payload = bullJob.data;
    const { runId, userId, searchTerms, activeTermIndex, locationSearch, limit, currentCycle, maxCycles, page } = payload;
    const searchTerm = searchTerms[activeTermIndex] || '';

    try {
      this.coordinator.updateStep(runId, 'step-6', 'running');
      this.coordinator.addLog(runId, `[Cycle ${currentCycle}] Running Vector Search, Hard Filters, and matching algorithms for "${searchTerm}"...`);

      // Run Matching & Ranking engine against Qdrant
      const rankedMatches = await this.matchingService.matchAndRankJobs(userId, limit);
      this.logger.log(`[MATCHING-WORKER] Found ${rankedMatches.length} matching jobs under run ${runId}`);
      
      const meetsLimit = rankedMatches.length >= limit;

      if (!meetsLimit) {
        if (currentCycle < maxCycles) {
          // Increment page & cycle, and enqueue next search cycle for the current term
          const nextCycle = currentCycle + 1;
          const nextPage = page + 1;

          this.coordinator.addLog(
            runId,
            `[Cycle ${currentCycle}] Found ${rankedMatches.length}/${limit} matches. Starting Cycle ${nextCycle} for "${searchTerm}"...`
          );
          this.coordinator.updateStep(runId, 'step-6', 'success');

          await this.discoveryQueue.add('discover-jobs', {
            ...payload,
            currentCycle: nextCycle,
            page: nextPage,
            accumulatedMatches: rankedMatches,
          });

          return { continue: true, nextCycle, nextPage };
        } else if (activeTermIndex + 1 < searchTerms.length) {
          // Move to next search term, resetting cycle and page
          const nextTermIndex = activeTermIndex + 1;
          const nextTerm = searchTerms[nextTermIndex];

          this.coordinator.addLog(
            runId,
            `[Cycle ${currentCycle}] Completed all cycles for "${searchTerm}". Moving to next search title: "${nextTerm}"...`
          );
          this.coordinator.updateStep(runId, 'step-6', 'success');

          await this.discoveryQueue.add('discover-jobs', {
            ...payload,
            activeTermIndex: nextTermIndex,
            currentCycle: 1,
            page: 1,
            accumulatedMatches: rankedMatches,
          });

          return { continue: true, nextTermIndex };
        }
      }

      // We either met the limit or reached maxCycles. Perform ranking & notifications.
      this.coordinator.updateStep(runId, 'step-6', 'success');
      this.coordinator.updateStep(runId, 'step-7', 'running');
      this.coordinator.addLog(runId, `Selecting top job matches and generating personalized AI explanations...`);

      // Sort and select top jobs up to the requested limit
      const sortedJobs = rankedMatches.sort((a, b) => b.finalScore - a.finalScore);
      const topJobs = sortedJobs.slice(0, limit);

      this.logger.log(`[MATCHING-WORKER] Selected top ${topJobs.length} matches. Sending alerts...`);

      const profileObj = await this.profileService.getProfileById(userId);

      for (const match of topJobs) {
        const { job, finalScore, skillScore, semanticScore, experienceScore, reasoning } = match;

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

        // Insert into results table, check for duplicate conflicts dynamically
        try {
          const insertRes = await this.db.query(`
            INSERT INTO results (user_id, job_id, company, title, location, source, url, score, reasoning, status, run_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'notified', $10)
            ON CONFLICT (user_id, job_id) DO NOTHING
            RETURNING id
          `, [
            userId,
            job.jobId,
            job.company,
            job.title,
            job.location,
            job.source,
            job.applyUrl || '',
            finalScore,
            aiReasoning,
            runId
          ]);

          if (insertRes.rowCount === 0) {
            this.logger.log(`[MATCHING-WORKER] Skipping notification: Job "${job.title}" at "${job.company}" was already notified in database.`);
            this.coordinator.addLog(runId, `Skipping notification: "${job.title}" at "${job.company}" was already notified.`);
            continue;
          }
        } catch (dbErr) {
          this.logger.error(`[MATCHING-WORKER] Failed to save result match to database: ${dbErr.message}`);
          continue; // Skip alerting if DB fails to ensure consistent state
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
        this.coordinator.addLog(runId, `Telegram alert sent successfully for "${job.title}" at ${job.company}.`);
      }

      this.coordinator.updateStep(runId, 'step-7', 'success');
      this.coordinator.completeRun(runId, `Workflow completed successfully. Found ${topJobs.length} matching jobs.`);

      return { completed: true, count: topJobs.length };
    } catch (err) {
      this.logger.error(`[MATCHING-WORKER] Matching worker failed: ${err.message}`, err.stack);
      this.coordinator.failRun(runId, `Matching stage failed: ${err.message}`);
      throw err;
    }
  }
}
