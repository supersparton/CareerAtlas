import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../vector-store/database.service';
import { UserProfile } from '../profile/profile.service';
import { MemoryService } from '../memory/memory.service';
import { JobRequirements } from '../intelligence/job-intelligence.service';
import { Job } from '../discovery/discovery.service';
import { QdrantService } from '../vector-store/qdrant.service';

export interface SkillScore {
  overlapSkills: string[];
  missingSkills: string[];
  score: number; // 0 to 100
}

export interface SemanticScore {
  score: number; // 0 to 100
}

export interface ExperienceScore {
  requiredYears: number;
  candidateYears: number;
  score: number; // 0 to 100
}

export interface EducationScore {
  score: number; // 0 to 100
}

export interface RankedJob {
  job: Job;
  finalScore: number;
  skillScore: number;
  semanticScore: number;
  experienceScore: number;
  educationScore: number;
  reasoning: string;
}

@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);

  // Skill Normalization Mapping
  private readonly SKILL_MAP: Record<string, string> = {
    'nestjs': 'node.js',
    'express': 'node.js',
    'expressjs': 'node.js',
    'koa': 'node.js',
    'fastapi': 'python',
    'django': 'python',
    'flask': 'python',
    'numpy': 'python',
    'pandas': 'python',
    'reactjs': 'react',
    'react.js': 'react',
    'nextjs': 'react',
    'next.js': 'react',
    'vuejs': 'vue',
    'vue.js': 'vue',
    'postgres': 'postgresql',
    'postgresql': 'postgresql',
    'mongodb': 'mongo',
    'ts': 'typescript',
    'js': 'javascript',
    'aws cloud': 'aws',
    'gcp cloud': 'gcp',
    'azure cloud': 'azure',
    'docker': 'devops',
    'kubernetes': 'devops',
    'k8s': 'devops',
  };

  constructor(
    private readonly db: DatabaseService,
    private readonly memoryService: MemoryService,
    private readonly qdrantService: QdrantService,
  ) {}

  /**
   * Main Orchestrator for Job Recommendation matching pipeline.
   */
  async matchAndRankJobs(userId: number, limit = 10): Promise<RankedJob[]> {
    this.logger.log(`[MATCHING] Running recommendation matching for user ID: ${userId}...`);
    
    // 1. Fetch User Profile
    const profile = await this.getUserProfile(userId);
    if (!profile) {
      this.logger.error(`[MATCHING] User profile for ID ${userId} not found.`);
      return [];
    }

    // 2. Fetch all ingested jobs and their structured requirements
    const jobsWithReqs = await this.getIngestedJobs();
    this.logger.log(`[MATCHING] Loaded ${jobsWithReqs.length} total jobs from database.`);

    // 3. Stage 3: Apply Hard Filters & Exclude already notified/seen jobs
    const filteredJobs = jobsWithReqs.filter(({ job, reqs }) => {
      if (this.memoryService.isJobMatched(job.company, job.title, job.location, job.source)) {
        return false;
      }
      return this.applyHardFilters(profile, reqs);
    });
    this.logger.log(`[MATCHING] Hard Filter Engine: Approved ${filteredJobs.length} / ${jobsWithReqs.length} jobs.`);
    
    if (filteredJobs.length === 0) return [];

    // 4. Batch Score Jobs
    const rankedJobs: RankedJob[] = [];
    
    for (const { job, reqs } of filteredJobs) {
      try {
        // Stage 4: Skill Match
        const skillResult = this.computeSkillScore(profile.skills, reqs.requiredSkills);

        // Stage 6: Semantic Match (pgvector Cosine Similarity)
        const semanticResult = await this.computeSemanticScore(userId, job.jobId);

        // Stage 7: Experience Match
        const experienceResult = this.computeExperienceScore(profile.experienceYears, reqs.experienceRequired);

        // Stage 8: Education Match
        const educationResult = this.computeEducationScore(profile.education, reqs.educationRequirements);

        // Location Match Boost: If physical location matches one of candidate's preferred cities
        let locationBoost = 0;
        let isLocalMatch = false;
        if (profile.preferences.locations && profile.preferences.locations.length > 0) {
          const jobLocLower = reqs.location.toLowerCase();
          isLocalMatch = profile.preferences.locations.some(loc => 
            jobLocLower.includes(loc.toLowerCase()) || loc.toLowerCase().includes(jobLocLower)
          );
          if (isLocalMatch) {
            locationBoost = 15; // +15 boost to prioritize local opportunities
          }
        }

        // Stage 9: Weighted Ranking Engine
        // Formula: 50% Skill + 30% Semantic + 15% Experience + 5% Education + locationBoost
        const baseScore = Math.round(
          (skillResult.score * 0.50) +
          (semanticResult.score * 0.30) +
          (experienceResult.score * 0.15) +
          (educationResult.score * 0.05)
        );
        const finalScore = Math.min(100, baseScore + locationBoost);

        // Build explaining reasoning
        const reasoning = `Matches ${skillResult.overlapSkills.length} core skills (${skillResult.score}% match). ` +
          `Semantic match is ${Math.round(semanticResult.score)}%. ` +
          `Experience requirement: ${reqs.experienceRequired} years vs Candidate: ${profile.experienceYears} years.` +
          (isLocalMatch ? ` Local match boost (+15) applied.` : '');

        rankedJobs.push({
          job,
          finalScore,
          skillScore: skillResult.score,
          semanticScore: semanticResult.score,
          experienceScore: experienceResult.score,
          educationScore: educationResult.score,
          reasoning,
        });
      } catch (err) {
        this.logger.error(`[MATCHING] Error matching job ${job.jobId}: ${err.message}`);
      }
    }

    // Filter by threshold (minimum matching score of 50)
    const qualifyingJobs = rankedJobs.filter(rj => rj.finalScore >= 50);
    this.logger.log(`[MATCHING] Ranking Engine: ${qualifyingJobs.length} / ${rankedJobs.length} jobs met the threshold requirements (score >= 50).`);

    // Sort descending
    const sorted = qualifyingJobs.sort((a, b) => b.finalScore - a.finalScore);
    return sorted.slice(0, limit);
  }

  /**
   * Stage 3: Hard Filter Engine (Mandatory constraints check)
   */
  private applyHardFilters(profile: UserProfile, reqs: JobRequirements): boolean {
    // A. Experience constraint: Candidate years must be >= Required years
    if (profile.experienceYears < reqs.experienceRequired) {
      return false;
    }

    // B. Remote preference:
    // If job does not allow remote and candidate ONLY wants remote
    const candidateLocations = (profile.preferences.locations || [])
      .map(loc => loc.trim())
      .filter(Boolean);

    const candidateWantsOnlyRemote = candidateLocations.length === 0 && profile.preferences.remote;
    if (candidateWantsOnlyRemote && !reqs.remoteAllowed) {
      return false;
    }

    // C. Location constraint:
    // Job location must be remote OR in candidate location list
    const isJobRemote = reqs.remoteAllowed || reqs.location.toLowerCase() === 'remote';
    const isCandidateOpenToRemote = profile.preferences.remote;

    // If job is remote-only (no physical location, e.g. location is 'remote') and candidate is NOT open to remote:
    if (reqs.location.toLowerCase() === 'remote' && !isCandidateOpenToRemote) {
      return false;
    }

    if (candidateLocations.length > 0) {
      // Candidate has specific physical location preferences.
      // If the job is remote and candidate is open to remote, it's a valid match.
      // Otherwise, the job MUST have a physical location that matches one of the candidate's preferences.
      if (isJobRemote && isCandidateOpenToRemote) {
        // Valid remote match
      } else {
        const jobLocLower = reqs.location.toLowerCase();
        const hasLocMatch = candidateLocations.some(loc => 
          jobLocLower.includes(loc.toLowerCase()) || loc.toLowerCase().includes(jobLocLower)
        );
        if (!hasLocMatch) {
          return false;
        }
      }
    } else {
      // Candidate has no specific physical location preferences (i.e. open to any physical location).
      // If they are NOT open to remote, and the job is remote-only, reject it.
      if (!isCandidateOpenToRemote && isJobRemote && reqs.location.toLowerCase() === 'remote') {
        return false;
      }
      // If they ONLY want remote (remote: true, locations: []), and the job is not remote:
      if (isCandidateOpenToRemote && candidateLocations.length === 0 && !isJobRemote) {
        return false;
      }
    }

    // D. Employment Type constraint:
    if (profile.preferences.employmentTypes && profile.preferences.employmentTypes.length > 0) {
      const jobEmpLower = reqs.employmentType.toLowerCase();
      const hasEmpTypeMatch = profile.preferences.employmentTypes.some(type => 
        jobEmpLower.includes(type.toLowerCase()) || type.toLowerCase().includes(jobEmpLower)
      );
      if (!hasEmpTypeMatch) {
        return false;
      }
    }

    return true;
  }

  /**
   * Stage 4: Skill Match Engine with Normalization
   */
  private computeSkillScore(candidateSkills: string[], requiredSkills: string[]): SkillScore {
    if (requiredSkills.length === 0) {
      return { overlapSkills: [], missingSkills: [], score: 100 };
    }

    const normalize = (skill: string) => {
      const clean = skill.toLowerCase().trim().replace(/[^a-z0-9\s#\+\.]/g, '');
      return this.SKILL_MAP[clean] || clean;
    };

    const normCandidateSkills = new Set(candidateSkills.map(normalize));
    const normRequiredSkills = requiredSkills.map(normalize);

    const overlapSkills: string[] = [];
    const missingSkills: string[] = [];

    requiredSkills.forEach((skill, index) => {
      const normReq = normRequiredSkills[index];
      if (normCandidateSkills.has(normReq)) {
        overlapSkills.push(skill);
      } else {
        missingSkills.push(skill);
      }
    });

    const score = Math.round((overlapSkills.length / requiredSkills.length) * 100);

    return { overlapSkills, missingSkills, score };
  }

  /**
   * Stage 6: Embedding Match Engine (Database-level pgvector similarity)
   */
  private async computeSemanticScore(userId: number, jobId: string): Promise<SemanticScore> {
    try {
      // 1. Retrieve user vector from Qdrant
      const userRes = await this.qdrantService.getClient().retrieve('user_embeddings', {
        ids: [userId],
        with_vector: true,
      });

      if (userRes.length === 0 || !userRes[0].vector) {
        this.logger.warn(`[MATCHING] User embedding not found in Qdrant for user ID: ${userId}`);
        return { score: 50 }; // Default neutral fallback
      }

      const userVector = userRes[0].vector as number[];

      // 2. Search job_embeddings matching the specific jobId payload key
      const searchRes = await this.qdrantService.getClient().search('job_embeddings', {
        vector: userVector,
        filter: {
          must: [
            {
              key: 'jobId',
              match: {
                value: jobId,
              },
            },
          ],
        },
        limit: 1,
      });

      if (searchRes.length === 0) {
        return { score: 50 }; // Default neutral fallback
      }

      const sim = searchRes[0].score;
      // Convert similarity range [-1, 1] to a percentage [0, 100]
      const pctScore = Math.max(0, Math.min(100, sim * 100));
      return { score: pctScore };
    } catch (err) {
      this.logger.error(`[MATCHING] Failed to calculate Qdrant cosine similarity: ${err.message}`);
      return { score: 0 };
    }
  }

  /**
   * Stage 7: Experience Match Engine (Non-linear scoring)
   */
  private computeExperienceScore(candidateYears: number, requiredYears: number): ExperienceScore {
    if (candidateYears >= requiredYears) {
      return { requiredYears, candidateYears, score: 100 };
    }
    // Underqualification deduction
    const deficit = requiredYears - candidateYears;
    const score = Math.max(0, Math.round(100 - deficit * 25));
    return { requiredYears, candidateYears, score };
  }

  /**
   * Stage 8: Education Match Engine
   */
  private computeEducationScore(candidateEdu: string[], requiredEdu: string[]): EducationScore {
    if (requiredEdu.length === 0) {
      return { score: 100 };
    }
    if (!candidateEdu || candidateEdu.length === 0) {
      return { score: 50 }; // Moderate score if candidate has no education info listed
    }

    const normRequired = requiredEdu.join(' ').toLowerCase();
    const isDegreeRequired = /bachelor|b\.tech|b\.e\.|m.tech|m\.s\.|phd|doctorate|degree/i.test(normRequired);

    if (!isDegreeRequired) {
      return { score: 100 };
    }

    // Check if candidate education contains key degrees required
    const eduMatches = candidateEdu.some(candEdu => {
      const candEduLower = candEdu.toLowerCase();
      // Match PhD
      if (normRequired.includes('phd') && candEduLower.includes('phd')) return true;
      // Match Masters
      if (normRequired.includes('master') && (candEduLower.includes('master') || candEduLower.includes('m.tech') || candEduLower.includes('m.s.'))) return true;
      // Match Bachelors
      if (normRequired.includes('bachelor') && (candEduLower.includes('bachelor') || candEduLower.includes('b.tech') || candEduLower.includes('b.e.') || candEduLower.includes('b.s.'))) return true;
      return false;
    });

    return { score: eduMatches ? 100 : 60 };
  }

  // Database helpers
  private async getUserProfile(userId: number): Promise<UserProfile | null> {
    try {
      const userRes = await this.db.query('SELECT * FROM users WHERE id = $1', [userId]);
      if (userRes.rows.length === 0) return null;

      const prefRes = await this.db.query('SELECT * FROM user_preferences WHERE user_id = $1', [userId]);
      const skillsRes = await this.db.query('SELECT skill FROM user_skills WHERE user_id = $1', [userId]);
      
      // Load raw projects/education from profile JSON file or DB if available, fallback to mock lists for matching structure
      const user = userRes.rows[0];
      const pref = prefRes.rows[0];
      const skills = skillsRes.rows.map(r => r.skill);

      return {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        skills,
        experienceYears: pref.experience_years,
        education: ['B.Tech in Computer Science', 'Bachelor Degree'], // Fallback structural profile match lists
        projects: [],
        achievements: [],
        preferredRoles: pref.preferred_roles,
        preferences: {
          locations: pref.locations,
          remote: pref.remote,
          employmentTypes: pref.employment_types,
          salaryExpectation: pref.salary_expectation || undefined,
        },
      };
    } catch (err) {
      this.logger.error(`[MATCHING] DB Error loading user profile: ${err.message}`);
      return null;
    }
  }

  private async getIngestedJobs(): Promise<{ job: Job; reqs: JobRequirements }[]> {
    const list: { job: Job; reqs: JobRequirements }[] = [];
    try {
      // Retrieve points from Qdrant scroll (limit 500 for matching pool)
      const res = await this.qdrantService.getClient().scroll('job_embeddings', {
        limit: 500,
        with_payload: true,
        with_vector: false,
      });

      for (const point of res.points) {
        const payload = point.payload as any;
        if (!payload) continue;

        list.push({
          job: {
            jobId: payload.jobId,
            source: 'TinyFish',
            title: payload.title,
            company: payload.company,
            location: payload.location,
            description: payload.description,
            applyUrl: payload.url,
          },
          reqs: {
            requiredSkills: payload.requiredSkills || [],
            preferredSkills: payload.preferredSkills || [],
            experienceRequired: payload.experienceRequired || 0,
            educationRequirements: payload.educationRequirements || [],
            employmentType: payload.employmentType || 'Full-time',
            remoteAllowed: !!payload.remoteAllowed,
            location: payload.location || 'Remote',
          },
        });
      }
    } catch (err) {
      this.logger.error(`[MATCHING] Qdrant Error loading ingested jobs: ${err.message}`);
    }
    return list;
  }
}
