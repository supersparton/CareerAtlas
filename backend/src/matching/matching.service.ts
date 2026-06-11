import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../vector-store/database.service';
import { UserProfile } from '../profile/profile.service';
import { JobRequirements } from '../intelligence/job-intelligence.service';
import { Job } from '../discovery/discovery.service';

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

  constructor(private readonly db: DatabaseService) {}

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

    // 3. Stage 3: Apply Hard Filters
    const filteredJobs = jobsWithReqs.filter(({ reqs }) => this.applyHardFilters(profile, reqs));
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

        // Stage 9: Weighted Ranking Engine
        // Formula: 50% Skill + 30% Semantic + 15% Experience + 5% Education
        const finalScore = Math.round(
          (skillResult.score * 0.50) +
          (semanticResult.score * 0.30) +
          (experienceResult.score * 0.15) +
          (educationResult.score * 0.05)
        );

        // Build explaining reasoning
        const reasoning = `Matches ${skillResult.overlapSkills.length} core skills (${skillResult.score}% match). ` +
          `Semantic match is ${Math.round(semanticResult.score)}%. ` +
          `Experience requirement: ${reqs.experienceRequired} years vs Candidate: ${profile.experienceYears} years.`;

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

    // Sort descending
    const sorted = rankedJobs.sort((a, b) => b.finalScore - a.finalScore);
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
    const candidateWantsOnlyRemote = profile.preferences.locations.length === 0 && profile.preferences.remote;
    if (candidateWantsOnlyRemote && !reqs.remoteAllowed) {
      return false;
    }

    // C. Location constraint:
    // Job location must be remote OR in candidate location list
    const isJobRemote = reqs.remoteAllowed || reqs.location.toLowerCase() === 'remote';
    const isCandidateOpenToRemote = profile.preferences.remote;

    if (isJobRemote && isCandidateOpenToRemote) {
      // Valid remote match
    } else if (profile.preferences.locations.length > 0) {
      // Compare physical locations
      const jobLocLower = reqs.location.toLowerCase();
      const hasLocMatch = profile.preferences.locations.some(loc => 
        jobLocLower.includes(loc.toLowerCase()) || loc.toLowerCase().includes(jobLocLower)
      );
      if (!hasLocMatch) {
        return false;
      }
    } else if (!isJobRemote) {
      // Candidate wants remote, job is onsite in some unspecified city
      return false;
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
      // Cosine similarity = 1 - cosine distance
      const queryText = `
        SELECT (1 - (je.embedding <=> ue.embedding)) AS similarity
        FROM job_embeddings je
        CROSS JOIN user_embeddings ue
        WHERE ue.user_id = $1 AND je.job_id = $2;
      `;
      const res = await this.db.query(queryText, [userId, jobId]);
      if (res.rows.length === 0) {
        return { score: 50 }; // Default neutral fallback
      }

      // Convert distance range [-1, 1] to a percentage [0, 100]
      const sim = parseFloat(res.rows[0].similarity) || 0;
      const pctScore = Math.max(0, Math.min(100, sim * 100));
      return { score: pctScore };
    } catch (err) {
      this.logger.error(`[MATCHING] Failed to calculate pgvector cosine similarity: ${err.message}`);
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
      const res = await this.db.query(`
        SELECT j.*, jr.required_skills, jr.preferred_skills, jr.experience_required, 
               jr.education_requirements, jr.employment_type, jr.remote_allowed, jr.actual_location
        FROM jobs j
        JOIN job_requirements jr ON j.id = jr.job_id
      `);

      for (const row of res.rows) {
        list.push({
          job: {
            jobId: row.id,
            source: 'TinyFish',
            title: row.title,
            company: row.company,
            location: row.location,
            description: row.description,
            applyUrl: row.url,
          },
          reqs: {
            requiredSkills: row.required_skills,
            preferredSkills: row.preferred_skills,
            experienceRequired: row.experience_required,
            educationRequirements: row.education_requirements,
            employmentType: row.employment_type,
            remoteAllowed: row.remote_allowed,
            location: row.actual_location,
          },
        });
      }
    } catch (err) {
      this.logger.error(`[MATCHING] DB Error loading ingested jobs: ${err.message}`);
    }
    return list;
  }
}
