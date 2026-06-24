import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ProfileService, UserProfile } from '../profile/profile.service';
import { DatabaseService } from '../vector-store/database.service';
import { PipelineCoordinatorService } from '../queues/pipeline-coordinator.service';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class AgentService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgentService.name);
  private activeUserId = 1; // Default user ID for single-user environment

  constructor(
    private readonly profileService: ProfileService,
    private readonly db: DatabaseService,
    private readonly coordinator: PipelineCoordinatorService,
    @InjectQueue('job-discovery') private readonly discoveryQueue: Queue,
  ) {}

  getPipelineStatus() {
    return this.coordinator.getActiveRunStatus();
  }

  async onApplicationBootstrap() {
    this.logger.log('[ORCHESTRATOR] Agent Bootstrapped. Syncing initial profile.json with database...');
    try {
      const fileProfile = this.profileService.getProfile();
      if (fileProfile && fileProfile.email) {
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
          education: fileProfile.education || [],
          projects: [],
          achievements: [],
          preferredRoles: [],
          preferences: {
            locations: [],
            remote: true,
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
   * Main suite runner triggered in the background
   */
  async runWorkflowSuite(
    searchTerms: string[],
    locationSearch: string,
    locationPref: string,
    isRemoteOpen: boolean,
    userEmail?: string,
    employmentTypes?: string[],
  ) {
    this.logger.log('[ORCHESTRATOR] Starting background job recommendation suite via BullMQ...');

    const runId = await this.db.getNextExecutionId();
    
    // Start run registration in coordinator
    this.coordinator.startRun(runId, this.activeUserId, searchTerms, locationSearch, 5);
    this.coordinator.updateStep(runId, 'step-1', 'running');
    this.coordinator.addLog(runId, 'Syncing profile details and user embedding with PostgreSQL / Supabase...');

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


        // Load, update profile, and regenerate Qdrant vector embeddings to reflect updated search parameters
        const profile = await this.profileService.getProfileById(resolvedUserId);
        if (profile) {
          profile.preferredRoles = searchTerms || [];
          profile.preferences.locations = [locationPref];
          profile.preferences.remote = isRemoteOpen;
          profile.preferences.employmentTypes = employmentTypes || ['Full-time'];

          // saveProfileToDb updates SQL tables AND updates the Qdrant user_embeddings collection
          await this.profileService.saveProfileToDb(profile);
          this.logger.log(`[ORCHESTRATOR] Synchronized runtime preferences and regenerated Qdrant embeddings for User ID ${resolvedUserId}: locations=[${locationPref}], remote=${isRemoteOpen}, employmentTypes=${JSON.stringify(employmentTypes)}`);
          this.coordinator.addLog(runId, `Runtime preferences and Qdrant vector embeddings synchronized for User ID ${resolvedUserId}.`);
        } else {
          // Fallback SQL upsert if no parsed profile exists yet
          await this.db.query(`
            INSERT INTO user_preferences (user_id, preferred_roles, locations, remote, employment_types, experience_years)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (user_id) DO UPDATE
            SET locations = EXCLUDED.locations,
                remote = EXCLUDED.remote,
                preferred_roles = EXCLUDED.preferred_roles,
                employment_types = EXCLUDED.employment_types;
          `, [
            resolvedUserId,
            searchTerms,
            [locationPref],
            isRemoteOpen,
            employmentTypes || ['Full-time'],
            0
          ]);
          this.logger.log(`[ORCHESTRATOR] SQL upsert fallback for User ID ${resolvedUserId}: locations=[${locationPref}], remote=${isRemoteOpen}`);
          this.coordinator.addLog(runId, `Runtime preferences fallback synchronized for User ID ${resolvedUserId}.`);
        }

        // Update the latest run ID in user preferences
        await this.db.query('UPDATE user_preferences SET latest_run_id = $1 WHERE user_id = $2', [runId, resolvedUserId]);
        this.coordinator.updateStep(runId, 'step-1', 'success');
      }
    } catch (err) {
      this.logger.error(`[ORCHESTRATOR] Failed to resolve active user ID and preferences: ${err.message}`);
      this.coordinator.failRun(runId, `Failed to sync profile: ${err.message}`);
      this.coordinator.updateStep(runId, 'step-1', 'error', err.message);
      return;
    }

    try {
      const targetLimit = 5;
      
      // Enqueue the first discovery job to kick off the BullMQ pipeline
      await this.discoveryQueue.add('discover-jobs', {
        runId,
        userId: resolvedUserId,
        searchTerms,
        activeTermIndex: 0,
        locationSearch,
        limit: targetLimit,
        currentCycle: 1,
        maxCycles: 3,
        page: 1,
        accumulatedMatches: [],
      });

      this.logger.log(`[ORCHESTRATOR] Successfully enqueued job search workflow in BullMQ for run ID: ${runId}`);
      this.coordinator.addLog(runId, `Workflow enqueued in BullMQ. Queue processing active.`);
    } catch (err) {
      this.logger.error(`[ORCHESTRATOR] Failed to enqueue workflow to BullMQ: ${err.message}`);
      this.coordinator.failRun(runId, `Enqueue failed: ${err.message}`);
    }
  }

  async getWorkflowResults(email?: string) {
    try {
      let resolvedUserId = this.activeUserId;
      if (email) {
        const userRes = await this.db.query('SELECT id FROM users WHERE email = $1', [email.trim().toLowerCase()]);
        if (userRes.rows.length > 0) {
          resolvedUserId = userRes.rows[0].id;
        }
      }

      const prefRes = await this.db.query('SELECT latest_run_id FROM user_preferences WHERE user_id = $1', [resolvedUserId]);
      const latestRunId = prefRes.rows[0]?.latest_run_id;

      if (!latestRunId) {
        return [];
      }

      const resultsRes = await this.db.query(`
        SELECT id, job_id as "jobId", company, title, location, source, url, score, reasoning, status, created_at as "createdAt"
        FROM results
        WHERE user_id = $1 AND run_id = $2
        ORDER BY score DESC, created_at DESC
        LIMIT 100
      `, [resolvedUserId, latestRunId]);

      return resultsRes.rows;
    } catch (err) {
      this.logger.error(`[ORCHESTRATOR] Failed to retrieve workflow results from DB: ${err.message}`);
      return [];
    }
  }

  async clearHistory(email?: string) {
    try {
      let resolvedUserId = this.activeUserId;
      if (email) {
        const userRes = await this.db.query('SELECT id FROM users WHERE email = $1', [email.trim().toLowerCase()]);
        if (userRes.rows.length > 0) {
          resolvedUserId = userRes.rows[0].id;
        }
      }

      // 1. Clear database results for the user
      await this.db.query('DELETE FROM results WHERE user_id = $1', [resolvedUserId]);
      this.logger.log(`[ORCHESTRATOR] Cleared results table history for User ID ${resolvedUserId}`);

      // 2. Reset JSON memory files to empty array
      const processedFilePath = path.join(process.cwd(), '..', 'processed_jobs.json');
      const matchedFilePath = path.join(process.cwd(), '..', 'seen_jobs.json');
      fs.writeFileSync(processedFilePath, JSON.stringify([]), 'utf-8');
      fs.writeFileSync(matchedFilePath, JSON.stringify([]), 'utf-8');
      this.logger.log('[ORCHESTRATOR] Reset processed_jobs.json and seen_jobs.json caches.');
    } catch (err) {
      this.logger.error(`[ORCHESTRATOR] Failed to clear history: ${err.message}`);
      throw err;
    }
  }
}
