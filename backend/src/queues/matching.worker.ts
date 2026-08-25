import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Queue, Job as BullJob } from 'bullmq';
import { Logger } from '@nestjs/common';
import { MatchingService } from '../matching/matching.service';
import { ProfileService } from '../profile/profile.service';
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
    private readonly coordinator: PipelineCoordinatorService,
    private readonly db: DatabaseService,
    @InjectQueue('job-discovery') private readonly discoveryQueue: Queue,
  ) {
    super();
  }

  async process(bullJob: BullJob<MatchingJobPayload>): Promise<any> {
    const matchingWorkerStart = Date.now();
    const payload = bullJob.data;
    const { runId, userId, searchTerms, activeTermIndex, locationSearch, limit, currentCycle, maxCycles, page } = payload;
    const searchTerm = searchTerms[activeTermIndex] || '';

    try {
      await this.coordinator.updateStep(runId, 'step-6', 'running');
      await this.coordinator.addLog(runId, `[Cycle ${currentCycle}] Running Vector Search, Hard Filters, and matching algorithms for "${searchTerm}"...`);

      // Run Matching & Ranking engine against Qdrant
      const engineStart = Date.now();
      const currentMatches = await this.matchingService.matchAndRankJobs(userId, limit);
      const engineMs = Date.now() - engineStart;
      this.logger.log(`[LATENCY] [job-matching] Match and rank algorithm completed in ${engineMs}ms (Found ${currentMatches.length} matches in current cycle) for run ${runId}`);

      // Merge and deduplicate matches across cycles/terms
      const prevMatches = payload.accumulatedMatches || [];
      const allMatchesMap = new Map<string, any>();
      for (const match of prevMatches) {
        if (match && match.job && match.job.jobId) {
          allMatchesMap.set(match.job.jobId, match);
        }
      }
      for (const match of currentMatches) {
        if (match && match.job && match.job.jobId) {
          allMatchesMap.set(match.job.jobId, match);
        }
      }
      const rankedMatches = Array.from(allMatchesMap.values());
      this.logger.log(`[MATCHING-WORKER] Total accumulated matching jobs under run ${runId}: ${rankedMatches.length}`);
      
      const meetsLimit = rankedMatches.length >= limit;

      if (!meetsLimit) {
        if (currentCycle < maxCycles) {
          // Increment page & cycle, and enqueue next search cycle for the current term
          const nextCycle = currentCycle + 1;
          const nextPage = page + 1;

          await this.coordinator.addLog(
            runId,
            `[Cycle ${currentCycle}] Found ${rankedMatches.length}/${limit} matches. Starting Cycle ${nextCycle} for "${searchTerm}"...`
          );
          await this.coordinator.updateStep(runId, 'step-6', 'success');

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

          await this.coordinator.addLog(
            runId,
            `[Cycle ${currentCycle}] Completed all cycles for "${searchTerm}". Moving to next search title: "${nextTerm}"...`
          );
          await this.coordinator.updateStep(runId, 'step-6', 'success');

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
      await this.coordinator.updateStep(runId, 'step-6', 'success');
      await this.coordinator.updateStep(runId, 'step-7', 'running');
      await this.coordinator.addLog(runId, `Selecting top job matches and generating personalized AI explanations...`);

      // Sort and select top jobs up to the requested limit (spread to avoid mutating original array)
      const sortedJobs = [...rankedMatches].sort((a, b) => b.finalScore - a.finalScore);
      const topJobs = sortedJobs.slice(0, limit);

      // Log ranked jobs
      for (const match of sortedJobs) {
        this.logger.log(`Job ranked: "${match.job.title}" at "${match.job.company}" - Score: ${match.finalScore}`);
      }

      this.logger.log(`[MATCHING-WORKER] Selected top ${topJobs.length} matches. Saving recommendation results to database...`);

      const profileObj = await this.profileService.getProfileById(userId);

      for (const match of topJobs) {
        const { job, finalScore, skillScore, semanticScore, experienceScore, reasoning, matchedSkills, missingSkills } = match;

        // Generate personalized LLM reasoning explanation
        let aiReasoning = reasoning;
        if (profileObj) {
          try {
            const matchedSkillsText = matchedSkills && matchedSkills.length > 0 ? matchedSkills.join(', ') : 'General software development skills';
            const missingSkillsText = missingSkills && missingSkills.length > 0 ? missingSkills.join(', ') : 'None';
            const projectsText = profileObj.projects && profileObj.projects.length > 0 ? profileObj.projects.join('; ') : 'Relevant technical projects';

            const reasoningPrompt = `
              You are an expert AI Career Advisor. Write a natural, highly personalized 2-sentence career match note for candidate ${profileObj.fullName}.

              Job Details:
              - Position: ${job.title} at ${job.company} (${job.location})
              
              Candidate Profile:
              - Full Name: ${profileObj.fullName}
              - Total Work Experience: ${profileObj.experienceYears} years
              - Key Skills: ${profileObj.skills.join(', ')}
              - Key Projects: ${projectsText}
              
              Match Breakdown:
              - Overall Fit Score: ${finalScore}%
              - Confirmed Matched Skills: ${matchedSkillsText}
              - Missing / Desirable Skills: ${missingSkillsText}

              Rules:
              1. Speak directly in plain, professional English. Never mention internal scoring formulas, numbers like "+21 pts", or technical code terms like "Subfamily" / "Family" / "Cards".
              2. Sentence 1: Highlight how the candidate's specific background in ${matchedSkillsText} or key projects makes them a compelling fit for ${job.title} at ${job.company}.
              3. Sentence 2: If there are missing skills (${missingSkillsText}), explain naturally how picking up those skills would strengthen their application; if no missing skills, express strong confidence in their candidacy.
              4. Write exactly 2 clean sentences with zero conversational filler or greetings.
            `;
            const startTime = Date.now();
            const response = await this.profileService.invokeModel(reasoningPrompt);
            const latency = Date.now() - startTime;
            if (response && response.trim()) {
              aiReasoning = response.trim();
            }
            this.logger.log(`LLM evaluation completed for "${job.title}" - Latency: ${latency}ms`);
          } catch (reasonErr) {
            this.logger.warn(`Failed to generate LLM reasoning for job ${job.jobId}: ${reasonErr.message}`);
          }
        }

        // Insert into results table, check for duplicate conflicts dynamically
        try {
          const insertRes = await this.db.query(`
            INSERT INTO results (user_id, job_id, company, title, location, source, url, score, reasoning, status, run_id, confidence_score, confidence_factors)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'notified', $10, $11, $12)
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
            runId,
            match.confidenceScore || 0,
            JSON.stringify(match.confidenceFactors || { positive: [], negative: [] })
          ]);

          if (insertRes.rowCount === 0) {
            this.logger.log(`[MATCHING-WORKER] Skipping duplicate save: Job "${job.title}" at "${job.company}" already exists in database.`);
            await this.coordinator.addLog(runId, `Skipping duplicate: "${job.title}" at "${job.company}" is already saved.`);
            continue;
          }
        } catch (dbErr) {
          this.logger.error(`[MATCHING-WORKER] Failed to save result match to database: ${dbErr.message}`);
          continue; 
        }

        await this.coordinator.addLog(runId, `Recommendation result saved successfully for "${job.title}" at ${job.company}.`);
      }

      this.logger.log(`Workflow finalizer completed. Top job matches finalized.`);

      const totalMatchingMs = Date.now() - matchingWorkerStart;
      this.logger.log(`[LATENCY] [job-matching] Overall matching worker stage completed in ${totalMatchingMs}ms for run ${runId}`);

      await this.coordinator.updateStep(runId, 'step-7', 'success');

      // Update agent search session history record with actual job count
      try {
        await this.db.query(
          'UPDATE agent_search_sessions SET job_count = $1 WHERE run_id = $2',
          [topJobs.length, runId],
        );
        this.logger.log(`[MATCHING-WORKER] Updated search session history job_count to ${topJobs.length} for run ${runId}`);
      } catch (sessErr: any) {
        this.logger.error(`[MATCHING-WORKER] Failed to update session job_count: ${sessErr.message}`);
      }

      await this.coordinator.completeRun(runId, `Workflow completed successfully. Found ${topJobs.length} matching jobs.`);

      return { completed: true, count: topJobs.length };
    } catch (err: any) {
      const totalMatchingMs = Date.now() - matchingWorkerStart;
      this.logger.error(`[LATENCY-ERROR] [job-matching] Matching worker stage failed after ${totalMatchingMs}ms: ${err.message}`, err.stack);
      await this.coordinator.failRun(runId, `Matching stage failed: ${err.message}`);
      throw err;
    }
  }
}
