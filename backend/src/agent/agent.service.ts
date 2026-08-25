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
  private defaultUserId = 1; // Fallback user ID for single-user environment

  constructor(
    private readonly profileService: ProfileService,
    private readonly db: DatabaseService,
    private readonly coordinator: PipelineCoordinatorService,
    @InjectQueue('job-discovery') private readonly discoveryQueue: Queue,
  ) {}

  async getPipelineStatus(runId?: string) {
    if (runId) {
      const run = await this.coordinator.getRun(runId);
      if (run) return run.status;
    }
    return await this.coordinator.getActiveRunStatus();
  }

  async onApplicationBootstrap() {
    this.logger.log('[ORCHESTRATOR] Agent Bootstrapped. Syncing initial profile with database if available...');
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
              : 1,
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
        this.defaultUserId = saved.id || 1;
        this.logger.log(`[ORCHESTRATOR] Profile synchronized to DB successfully. Active User ID: ${this.defaultUserId}`);
      }
    } catch (err: any) {
      this.logger.warn(`[ORCHESTRATOR] Profile startup sync notice: ${err.message}`);
    }
  }

  /**
   * Synchronously initializes a new pipeline run registration and triggers async execution
   */
  async startWorkflowRun(
    searchTerms: string[],
    locationSearch: string,
    locationPref: string,
    isRemoteOpen: boolean,
    userEmail?: string,
    employmentTypes?: string[],
  ): Promise<string> {
    const runId = await this.db.getNextExecutionId();
    
    // Synchronously register run in coordinator before HTTP response
    await this.coordinator.startRun(runId, this.activeUserId, searchTerms, locationSearch, 5);
    await this.coordinator.updateStep(runId, 'step-1', 'running');
    await this.coordinator.addLog(runId, 'Syncing profile details and user embedding with PostgreSQL / Supabase...');

    // Asynchronously trigger execution suite
    (async () => {
      try {
        await this.runWorkflowSuite(
          runId,
          searchTerms,
          locationSearch,
          locationPref,
          isRemoteOpen,
          userEmail,
          employmentTypes,
        );
        this.logger.log(`[BACKGROUND AGENT] Finished workflow run ${runId}`);
      } catch (err: any) {
        this.logger.error(`[BACKGROUND AGENT] Run ${runId} failed: ${err.message}`, err.stack);
        await this.coordinator.failRun(runId, String(err.message || err));
      }
    })();

    return runId;
  }

  /**
   * Main suite runner triggered in the background
   */
  async runWorkflowSuite(
    runId: string,
    searchTerms: string[],
    locationSearch: string,
    locationPref: string,
    isRemoteOpen: boolean,
    userEmail?: string,
    employmentTypes?: string[],
  ) {
    this.logger.log(`[ORCHESTRATOR] Executing job recommendation suite for run ID: ${runId}...`);

    let resolvedUserId = this.defaultUserId;
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
          await this.coordinator.addLog(runId, `Runtime preferences and Qdrant vector embeddings synchronized for User ID ${resolvedUserId}.`);
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
          await this.coordinator.addLog(runId, `Runtime preferences fallback synchronized for User ID ${resolvedUserId}.`);
        }

        // Update the latest run ID in user preferences
        await this.db.query('UPDATE user_preferences SET latest_run_id = $1 WHERE user_id = $2', [runId, resolvedUserId]);
        await this.coordinator.updateStep(runId, 'step-1', 'success');
      }
    } catch (err: any) {
      this.logger.error(`[ORCHESTRATOR] Failed to resolve active user ID and preferences: ${err.message}`);
      await this.coordinator.failRun(runId, `Failed to sync profile: ${err.message}`);
      await this.coordinator.updateStep(runId, 'step-1', 'error', err.message);
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
      await this.coordinator.addLog(runId, `Workflow enqueued in BullMQ. Queue processing active.`);

      // Record search session in database history
      await this.recordSearchSession(userEmail, searchTerms[0] || 'Software Engineer', locationPref, 0, runId);
    } catch (err: any) {
      this.logger.error(`[ORCHESTRATOR] Failed to enqueue workflow to BullMQ: ${err.message}`);
      await this.coordinator.failRun(runId, `Enqueue failed: ${err.message}`);
    }
  }

  async recordSearchSession(
    userEmail: string | undefined,
    searchTitle: string,
    locationPref: string,
    jobCount: number,
    runId: string,
  ) {
    try {
      let resolvedUserId = this.defaultUserId;
      if (userEmail) {
        const userRes = await this.db.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [userEmail.trim()]);
        if (userRes.rows.length > 0) resolvedUserId = userRes.rows[0].id;
      }

      const verRes = await this.db.query('SELECT id FROM resume_versions WHERE user_id = $1 AND is_active = true LIMIT 1', [resolvedUserId]);
      const versionId = verRes.rows.length > 0 ? verRes.rows[0].id : null;

      await this.db.query(`
        INSERT INTO agent_search_sessions (user_id, version_id, search_title, location_pref, job_count, run_id)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [resolvedUserId, versionId, searchTitle, locationPref, jobCount, runId]);

      this.logger.log(`[AGENT: HISTORY] Recorded search session for User ${resolvedUserId}, Version ${versionId}: "${searchTitle}"`);
    } catch (err: any) {
      this.logger.error(`[AGENT: HISTORY] Failed to record search session: ${err.message}`);
    }
  }

  async getSearchHistory(email?: string, versionId?: number) {
    try {
      let resolvedUserId = this.defaultUserId;
      if (email) {
        const userRes = await this.db.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email.trim()]);
        if (userRes.rows.length > 0) resolvedUserId = userRes.rows[0].id;
      }

      let queryText = `
        SELECT s.id, s.search_title as "searchTitle", s.location_pref as "locationPref",
               s.job_count as "jobCount", s.run_id as "runId", s.created_at as "createdAt",
               v.version_name as "versionName"
        FROM agent_search_sessions s
        LEFT JOIN resume_versions v ON s.version_id = v.id
        WHERE s.user_id = $1
      `;
      const params: any[] = [resolvedUserId];

      if (versionId) {
        queryText += ` AND s.version_id = $2`;
        params.push(versionId);
      }

      queryText += ` ORDER BY s.created_at DESC LIMIT 30`;

      const res = await this.db.query(queryText, params);
      return res.rows.map((r) => ({
        id: String(r.id),
        title: `${r.searchTitle} (${r.locationPref})`,
        searchTitle: r.searchTitle,
        locationPref: r.locationPref,
        jobCount: r.jobCount,
        runId: r.runId,
        timestamp: new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      }));
    } catch (err: any) {
      this.logger.error(`[AGENT: HISTORY] Failed to get search history: ${err.message}`);
      return [];
    }
  }

  async getSessionResults(sessionId: number, email?: string) {
    try {
      let resolvedUserId = this.defaultUserId;
      if (email) {
        const userRes = await this.db.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email.trim()]);
        if (userRes.rows.length > 0) resolvedUserId = userRes.rows[0].id;
      }

      const sessRes = await this.db.query('SELECT * FROM agent_search_sessions WHERE id = $1 AND user_id = $2', [sessionId, resolvedUserId]);
      if (sessRes.rows.length === 0) return { session: null, results: [] };

      const session = sessRes.rows[0];
      const runId = session.run_id;

      let resultsRes;
      if (runId) {
        resultsRes = await this.db.query(`
          SELECT id, job_id as "jobId", company, title, location, source, url, score, reasoning, status, created_at as "createdAt",
                 confidence_score as "confidenceScore", confidence_factors as "confidenceFactors"
          FROM results
          WHERE user_id = $1 AND run_id = $2
          ORDER BY score DESC, created_at DESC
          LIMIT 100
        `, [resolvedUserId, runId]);
      } else {
        resultsRes = await this.db.query(`
          SELECT id, job_id as "jobId", company, title, location, source, url, score, reasoning, status, created_at as "createdAt",
                 confidence_score as "confidenceScore", confidence_factors as "confidenceFactors"
          FROM results
          WHERE user_id = $1
          ORDER BY score DESC, created_at DESC
          LIMIT 100
        `, [resolvedUserId]);
      }

      return {
        session: {
          id: String(session.id),
          searchTitle: session.search_title,
          locationPref: session.location_pref,
          jobCount: session.job_count,
        },
        results: resultsRes.rows,
      };
    } catch (err: any) {
      this.logger.error(`[AGENT: HISTORY] Failed to get session results: ${err.message}`);
      return { session: null, results: [] };
    }
  }

  async getWorkflowResults(email?: string) {
    try {
      let resolvedUserId = this.defaultUserId;
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
        SELECT id, job_id as "jobId", company, title, location, source, url, score, reasoning, status, created_at as "createdAt",
               confidence_score as "confidenceScore", confidence_factors as "confidenceFactors"
        FROM results
        WHERE user_id = $1 AND run_id = $2
        ORDER BY score DESC, created_at DESC
        LIMIT 100
      `, [resolvedUserId, latestRunId]);

      return resultsRes.rows;
    } catch (err: any) {
      this.logger.error(`[ORCHESTRATOR] Failed to retrieve workflow results from DB: ${err.message}`);
      return [];
    }
  }

  async clearHistory(email?: string) {
    try {
      let resolvedUserId = this.defaultUserId;
      if (email) {
        const userRes = await this.db.query('SELECT id FROM users WHERE email = $1', [email.trim().toLowerCase()]);
        if (userRes.rows.length > 0) {
          resolvedUserId = userRes.rows[0].id;
        }
      }

      // Clear database results & search sessions for the user
      await this.db.query('DELETE FROM agent_search_sessions WHERE user_id = $1', [resolvedUserId]);
      await this.db.query('DELETE FROM results WHERE user_id = $1', [resolvedUserId]);
      this.logger.log(`[ORCHESTRATOR] Cleared results table history for User ID ${resolvedUserId}`);
    } catch (err: any) {
      this.logger.error(`[ORCHESTRATOR] Failed to clear history: ${err.message}`);
      throw err;
    }
  }
}
