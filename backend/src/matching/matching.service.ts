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
    this.logger.log(`[MATCHING] Running semantic recommendation matching for user ID: ${userId}...`);
    
    // 1. Fetch User Profile from database
    const profile = await this.getUserProfile(userId);
    if (!profile) {
      this.logger.error(`[MATCHING] User profile for ID ${userId} not found.`);
      return [];
    }

    // 2. Retrieve user vector from Qdrant
    let userVector: number[] | null = null;
    try {
      const userUuid = QdrantService.stringToUuid(userId.toString());
      const userRes = await this.qdrantService.getClient().retrieve('user_embeddings', {
        ids: [userUuid],
        with_vector: true,
      });
      if (userRes.length > 0 && userRes[0].vector) {
        userVector = userRes[0].vector as number[];
      }
    } catch (vectorErr) {
      this.logger.error(`[MATCHING] Error loading user vector from Qdrant: ${vectorErr.message}`);
    }

    if (!userVector) {
      this.logger.error(`[MATCHING] Cannot run semantic search: User vector embedding not found for user ID: ${userId}`);
      return [];
    }

    // 3. Search job_embeddings in Qdrant semantically
    const jobsWithReqs: { job: Job; reqs: JobRequirements; similarity: number }[] = [];
    try {
      this.logger.log(`[MATCHING] Querying Qdrant semantically using user vector...`);
      const searchRes = await this.qdrantService.getClient().search('job_embeddings', {
        vector: userVector,
        limit: 150, // Fetch top 150 semantically relevant jobs
        with_payload: true,
        with_vector: false,
      });

      for (const point of searchRes) {
        const payload = point.payload as any;
        if (!payload) continue;

        jobsWithReqs.push({
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
          similarity: point.score,
        });
      }
    } catch (qdrantErr) {
      this.logger.error(`[MATCHING] Qdrant search failed: ${qdrantErr.message}`);
      return [];
    }

    this.logger.log(`[MATCHING] Loaded ${jobsWithReqs.length} semantically similar jobs from Qdrant.`);

    // 4. Apply Hard Filters & Exclude already notified/seen jobs
    const seenJobRes = await this.db.query('SELECT job_id FROM results WHERE user_id = $1', [userId]);
    const seenJobIds = new Set(seenJobRes.rows.map((r) => r.job_id));

    const filteredJobs = jobsWithReqs.filter(({ job, reqs }) => {
      if (seenJobIds.has(job.jobId)) {
        return false;
      }
      return this.applyHardFilters(profile, reqs, job.title, job.description || '');
    });
    this.logger.log(`[MATCHING] Hard Filter Engine: Approved ${filteredJobs.length} / ${jobsWithReqs.length} jobs.`);
    
    if (filteredJobs.length === 0) return [];

    // 5. Pack results (using similarity score as the rank indicator)
    const rankedJobs: RankedJob[] = [];
    for (const { job, reqs, similarity } of filteredJobs) {
      try {
        const finalScore = Math.round(Math.max(0, Math.min(100, similarity * 100)));

        rankedJobs.push({
          job,
          finalScore,
          skillScore: 100,
          semanticScore: finalScore,
          experienceScore: 100,
          educationScore: 100,
          reasoning: `Matched role "${job.title}" at ${job.company} with ${finalScore}% semantic similarity.`,
        });
      } catch (err) {
        this.logger.error(`[MATCHING] Error packing job ${job.jobId}: ${err.message}`);
      }
    }

    // Sort descending
    const sorted = rankedJobs.sort((a, b) => b.finalScore - a.finalScore);
    return sorted.slice(0, limit);
  }

  /**
   * Stage 3: Hard Filter Engine (Mandatory constraints check)
   */
  private applyHardFilters(profile: UserProfile, reqs: JobRequirements, jobTitle: string, jobDescription: string): boolean {
    const titleLower = jobTitle.toLowerCase();
    const descLower = jobDescription.toLowerCase();
    
    // 1. Role / Search Term Filter
    if (profile.preferredRoles && profile.preferredRoles.length > 0) {
      const isTitleMatch = profile.preferredRoles.some(role => {
        const roleLower = role.toLowerCase().trim();
        return titleLower.includes(roleLower) || roleLower.includes(titleLower);
      });
      if (!isTitleMatch) {
        return false;
      }
    }

    // 2. Seniority & Experience Filter
    let minYearsRequired = reqs.experienceRequired || 0;
    let maxYearsRequired = 100;
    
    const textToScan = titleLower + ' ' + descLower;

    // Principal / Architect / VP / Director / IC5 / IC6 / L7 / L8
    if (
      /\b(principal|architect|director|vp|head|vice president|ic5|ic6|l7|l8)\b/i.test(titleLower) ||
      /\b(career level - ic5|career level - ic6|level 7|level 8)\b/i.test(textToScan)
    ) {
      minYearsRequired = Math.max(minYearsRequired, 8);
    }
    // Lead / Staff / Manager / IC4 / L6
    else if (
      /\b(lead|manager|staff|engineering lead|tech lead|ic4|l6)\b/i.test(titleLower) ||
      /\b(career level - ic4|level 6)\b/i.test(textToScan)
    ) {
      minYearsRequired = Math.max(minYearsRequired, 6);
    }
    // Senior / SDE 3 / SDE III / IC3 / L5 / Developer 3
    else if (
      /\b(senior|sr\b|sr\.|\biii\b|sde 3|sde iii|sde-3|sde-iii|developer 3|ic3|l5)\b/i.test(titleLower) ||
      /\b(career level - ic3|level 5)\b/i.test(textToScan)
    ) {
      minYearsRequired = Math.max(minYearsRequired, 5);
    }
    // Mid-Level / SDE 2 / SDE II / IC2 / L4 / Developer 2
    else if (
      /\b(mid|intermediate|sde 2|sde ii|sde-2|sde-ii|developer 2|ic2|l4)\b/i.test(titleLower) ||
      /\b(career level - ic2|level 4)\b/i.test(textToScan)
    ) {
      minYearsRequired = Math.max(minYearsRequired, 2);
      maxYearsRequired = 5;
    }
    // Fresher / Entry-Level / Intern / SDE 1 / SDE I / IC1 / L3 / Developer 1
    else if (
      /\b(intern|internship|fresher|entry level|associate|graduate|trainee|sde 1|sde i|sde-1|sde-i|developer 1|ic1|l3)\b/i.test(titleLower) ||
      /\b(career level - ic1|level 3)\b/i.test(textToScan)
    ) {
      minYearsRequired = 0;
      maxYearsRequired = 2;
    }

    // Explicit years match
    const yearsMatch = textToScan.match(/\b(\d+)\s*\+?\s*years?\s+(?:of\s+)?experience\b/i);
    if (yearsMatch) {
      const explicitYears = parseInt(yearsMatch[1], 10);
      minYearsRequired = Math.max(minYearsRequired, explicitYears);
    }

    const candidateYears = profile.experienceYears;

    // Reject if candidate doesn't have enough experience
    if (candidateYears < minYearsRequired) {
      return false;
    }

    // Reject if candidate is highly overqualified (e.g. senior matching entry level role)
    if (candidateYears >= 5 && maxYearsRequired <= 2) {
      return false;
    }

    // 3. Remote & Location constraint checks
    const candidateLocations = (profile.preferences.locations || [])
      .map(loc => loc.trim().toLowerCase())
      .filter(Boolean);
    const isCandidateOpenToRemote = !!profile.preferences.remote;
    
    const jobLocLower = (reqs.location || '').toLowerCase();
    const isJobRemote = !!reqs.remoteAllowed || jobLocLower.includes('remote') || descLower.includes('remote');

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
        const isBangalore = (s: string) => s.includes('bangalore') || s.includes('bengaluru');
        if (isBangalore(jobLocLower) && isBangalore(prefLoc)) {
          return true;
        }
        return false;
      });

      if (hasPhysicalMatch) {
        return true;
      }

      // If no direct physical match, check if we can match via remote
      if (isJobRemote && isCandidateOpenToRemote) {
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
          if (jobLocLower.includes('usa') || jobLocLower.includes('united states') || jobLocLower.includes('canada') || jobLocLower.includes('uk') || jobLocLower.includes('united kingdom') || jobLocLower.includes('europe') || jobLocLower.includes('latam')) {
            return false;
          }
        } else if (isCandidateInCanada) {
          if (jobLocLower.includes('usa') || jobLocLower.includes('united states') || jobLocLower.includes('india') || jobLocLower.includes('uk') || jobLocLower.includes('united kingdom') || jobLocLower.includes('europe') || jobLocLower.includes('vancouver') || jobLocLower.includes('bc') || jobLocLower.includes('alberta')) {
            return false;
          }
        } else if (isCandidateInUS) {
          if (jobLocLower.includes('india') || jobLocLower.includes('canada') || jobLocLower.includes('uk') || jobLocLower.includes('united kingdom') || jobLocLower.includes('europe')) {
            return false;
          }
        }
        
        return true;
      }

      return false;
    } else {
      if (!isCandidateOpenToRemote && isJobRemote) {
        return false;
      }
    }

    // 4. Employment Type constraint check
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
