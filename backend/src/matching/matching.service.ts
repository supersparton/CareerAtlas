import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../vector-store/database.service';
import { UserProfile } from '../profile/profile.service';
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
    const seenJobRes = await this.db.query('SELECT job_id FROM results WHERE user_id = $1', [userId]);
    const seenJobIds = new Set(seenJobRes.rows.map((r) => r.job_id));

    const filteredJobs = jobsWithReqs.filter(({ job, reqs }) => {
      if (seenJobIds.has(job.jobId)) {
        return false;
      }
      return this.applyHardFilters(profile, reqs, job.title);
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
  private applyHardFilters(profile: UserProfile, reqs: JobRequirements, jobTitle: string): boolean {
    const titleLower = jobTitle.toLowerCase();
    
    // Determine inferred minimum experience based on seniority keywords in job title
    let inferredExperienceRequired = 0;
    if (/\b(principal|staff|architect|director|vp|head|vice president)\b/i.test(titleLower)) {
      inferredExperienceRequired = 8;
    } else if (/\b(lead|manager|engineering lead|tech lead)\b/i.test(titleLower)) {
      inferredExperienceRequired = 6;
    } else if (/\b(senior|sr\b|sr\.|\biii\b|\biv\b|\bv\b)\b/i.test(titleLower)) {
      inferredExperienceRequired = 5;
    }

    const effectiveExperienceRequired = Math.max(reqs.experienceRequired, inferredExperienceRequired);

    // 1. Determine Candidate Seniority Level based on actual parsed experience
    const candidateYears = profile.experienceYears;
    let candidateSeniority = 'Junior';
    if (candidateYears >= 8) {
      candidateSeniority = 'Lead/Principal';
    } else if (candidateYears >= 5) {
      candidateSeniority = 'Senior';
    } else if (candidateYears >= 2) {
      candidateSeniority = 'Mid';
    }

    // 2. Determine Job Seniority Level based on title keywords and required experience
    let jobSeniority = 'Junior';
    if (/\b(principal|staff|architect|director|vp|head|vice president)\b/i.test(titleLower) || reqs.experienceRequired >= 8) {
      jobSeniority = 'Lead/Principal';
    } else if (/\b(lead|manager|engineering lead|tech lead)\b/i.test(titleLower) || reqs.experienceRequired >= 6) {
      jobSeniority = 'Lead';
    } else if (/\b(senior|sr\b|sr\.|\biii\b|\biv\b|\bv\b)\b/i.test(titleLower) || reqs.experienceRequired >= 5) {
      jobSeniority = 'Senior';
    } else if (reqs.experienceRequired >= 2) {
      jobSeniority = 'Mid';
    }

    // 3. Seniority Exclusions: Prevent senior recommendations reaching junior candidates
    if (candidateSeniority === 'Junior') {
      if (jobSeniority === 'Senior' || jobSeniority === 'Lead' || jobSeniority === 'Lead/Principal') {
        return false;
      }
    }
    if (candidateSeniority === 'Mid') {
      if (jobSeniority === 'Lead/Principal') {
        return false;
      }
    }

    // 4. Experience constraint check with a minor grace period for senior candidates
    const allowedDeficit = (effectiveExperienceRequired >= 5 && candidateYears >= 3) ? 1.5 : 0;
    if (candidateYears + allowedDeficit < effectiveExperienceRequired) {
      return false;
    }

    // 5. Remote & Location constraint checks
    const candidateLocations = (profile.preferences.locations || [])
      .map(loc => loc.trim().toLowerCase())
      .filter(Boolean);
    const isCandidateOpenToRemote = !!profile.preferences.remote;
    
    const jobLocLower = (reqs.location || '').toLowerCase();
    const isJobRemote = !!reqs.remoteAllowed || jobLocLower.includes('remote');

    // If candidate has disabled remote completely, reject any remote jobs
    if (!isCandidateOpenToRemote && isJobRemote) {
      return false;
    }

    // If candidate has specified preferred physical locations
    if (candidateLocations.length > 0) {
      const hasPhysicalMatch = candidateLocations.some(prefLoc => {
        if (jobLocLower.includes(prefLoc) || prefLoc.includes(jobLocLower)) {
          return true;
        }
        // Bangalore <-> Bengaluru synonym resolution
        const isBangalore = (s: string) => s.includes('bangalore') || s.includes('bengaluru');
        if (isBangalore(jobLocLower) && isBangalore(prefLoc)) {
          return true;
        }
        return false;
      });

      if (hasPhysicalMatch) {
        // Direct physical match is always allowed
        return true;
      }

      // If no direct physical match, check if we can match via remote
      if (isJobRemote && isCandidateOpenToRemote) {
        // Candidate and job both allow remote, but check for country/province conflicts
        const isCandidateInIndia = candidateLocations.some(loc => 
          loc.includes('india') || loc.includes('bangalore') || loc.includes('bengaluru') || loc.includes('ahmedabad') || loc.includes('noida') || loc.includes('delhi') || loc.includes('mumbai') || loc.includes('pune')
        );
        const isCandidateInCanada = candidateLocations.some(loc => 
          loc.includes('canada') || loc.includes('ontario') || loc.includes('toronto') || loc.includes('vancouver') || loc.includes('bc') || loc.includes('alberta')
        );
        const isCandidateInUS = candidateLocations.some(loc => 
          loc.includes('usa') || loc.includes('united states') || loc.includes('california') || loc.includes('new york') || loc.includes('texas') || loc.includes('sf') || loc.includes('chicago')
        );

        if (isCandidateInIndia) {
          // Reject if job explicitly targets US, Canada, Europe, Latam, etc.
          if (jobLocLower.includes('usa') || jobLocLower.includes('united states') || jobLocLower.includes('canada') || jobLocLower.includes('uk') || jobLocLower.includes('united kingdom') || jobLocLower.includes('europe') || jobLocLower.includes('latam')) {
            return false;
          }
        } else if (isCandidateInCanada) {
          // Reject if job specifies US, India, UK, etc. Also reject out-of-province remote roles (e.g. Vancouver/BC if user preferred Ontario)
          if (jobLocLower.includes('usa') || jobLocLower.includes('united states') || jobLocLower.includes('india') || jobLocLower.includes('uk') || jobLocLower.includes('united kingdom') || jobLocLower.includes('europe') || jobLocLower.includes('vancouver') || jobLocLower.includes('bc') || jobLocLower.includes('alberta')) {
            return false;
          }
        } else if (isCandidateInUS) {
          // Reject if job specifies India, Canada, UK, Europe, etc.
          if (jobLocLower.includes('india') || jobLocLower.includes('canada') || jobLocLower.includes('uk') || jobLocLower.includes('united kingdom') || jobLocLower.includes('europe')) {
            return false;
          }
        }
        
        return true;
      }

      // No physical match and remote is not available/valid
      return false;
    } else {
      // Candidate has no physical location preferences (open to any location)
      if (!isCandidateOpenToRemote && isJobRemote) {
        return false;
      }
    }

    // 6. Employment Type constraint check
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
      // 1. Retrieve user vector from Qdrant using the correct UUID format
      const userUuid = QdrantService.stringToUuid(userId.toString());
      const userRes = await this.qdrantService.getClient().retrieve('user_embeddings', {
        ids: [userUuid],
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
