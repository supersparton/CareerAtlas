import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseService } from '../vector-store/database.service';
import { UserProfile } from '../profile/profile.service';
import { JobRequirements } from '../intelligence/job-intelligence.service';
import { Job } from '../discovery/discovery.service';
import { QdrantService } from '../vector-store/qdrant.service';
import { detectFamily, isAncestor } from './roleTaxonomy';

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

  private stats = {
    titleReject: 0,
    locationReject: 0,
    experienceReject: 0,
    employmentReject: 0,
    remoteReject: 0,
    solelyExperienceReject: 0,
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

    console.log(`
[TRACE] before_matching:
canonical_role: ${JSON.stringify(profile.preferredRoles)}
`);

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

    this.stats = {
      titleReject: 0,
      locationReject: 0,
      experienceReject: 0,
      employmentReject: 0,
      remoteReject: 0,
      solelyExperienceReject: 0,
    };

    const filteredJobs = jobsWithReqs.filter(({ job, reqs }) => {
      if (seenJobIds.has(job.jobId)) {
        return false;
      }
      return this.applyHardFilters(profile, reqs, job.title, job.description || '', job.company);
    });

    console.log(`
Rejected by title
${this.stats.titleReject}

Rejected by location
${this.stats.locationReject}

Rejected by experience
${this.stats.experienceReject}

Rejected by employment
${this.stats.employmentReject}

Rejected by remote
${this.stats.remoteReject}

Rejected solely because of experience
${this.stats.solelyExperienceReject}
`);

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

  private writeDetailedMatchLog(logText: string) {
    try {
      const workspaceRoot = process.cwd();
      let rootDir = workspaceRoot;
      if (fs.existsSync(path.join(workspaceRoot, 'backend'))) {
        rootDir = workspaceRoot;
      } else {
        const parent = path.resolve(workspaceRoot, '..');
        if (fs.existsSync(path.join(parent, 'backend'))) {
          rootDir = parent;
        }
      }
      const outputDir = path.join(rootDir, 'output');
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      const logFile = path.join(outputDir, 'matching_decisions.log');
      fs.appendFileSync(logFile, logText + '\n', 'utf8');
    } catch (err) {
      // fallback
    }
  }

  private readonly roleAliases: { [key: string]: string[] } = {
    'software engineer': [
      'software engineer',
      'software developer',
      'sde',
      'sde i',
      'sde-ii',
      'sde-2',
      'sde-1',
      'sde-3',
      'sde iii',
      'senior software engineer',
      'junior software engineer',
      'application engineer',
      'member of technical staff',
      'mts',
      'technical staff member',
      'software development engineer'
    ],
    'backend engineer': [
      'backend engineer',
      'backend developer',
      'node.js developer',
      'node developer',
      'python backend developer',
      'python developer',
      'java developer',
      'java backend developer',
      'golang developer',
      'golang backend developer',
      'go developer',
      'c# developer',
      'dot net developer',
      '.net developer',
      'backend software engineer'
    ],
    'frontend engineer': [
      'frontend engineer',
      'frontend developer',
      'front-end developer',
      'front end developer',
      'react developer',
      'react.js developer',
      'vue developer',
      'angular developer',
      'ui engineer',
      'ui developer',
      'frontend software engineer'
    ],
    'fullstack engineer': [
      'fullstack engineer',
      'full stack developer',
      'full-stack developer',
      'full stack engineer',
      'fullstack developer'
    ],
    'data analyst': [
      'data analyst',
      'business analyst',
      'analytics engineer',
      'product analyst',
      'data analytics'
    ],
    'data engineer': [
      'data engineer',
      'data platform engineer',
      'big data engineer',
      'analytics engineer'
    ],
    'data scientist': [
      'data scientist',
      'machine learning engineer',
      'ml engineer',
      'ai engineer',
      'applied scientist'
    ],
    'devops engineer': [
      'devops engineer',
      'site reliability engineer',
      'sre',
      'platform engineer',
      'cloud engineer',
      'systems engineer'
    ],
    'product manager': [
      'product manager',
      'pm',
      'associate product manager',
      'technical product manager'
    ]
  };

  private readonly locationSynonyms: { [key: string]: string } = {
    'bangalore': 'bengaluru',
    'banglore': 'bengaluru',
    'bangalore urban': 'bengaluru',
    'bengaluru': 'bengaluru',
    'mumbai': 'mumbai',
    'bombay': 'mumbai',
    'new york': 'new york',
    'new york city': 'new york',
    'nyc': 'new york',
    'ny': 'new york',
    'san francisco': 'san francisco',
    'sf': 'san francisco',
    'bay area': 'san francisco'
  };

  private computeStringSimilarity(str1: string, str2: string): { score: number; method: string } {
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();

    if (s1 === s2) {
      return { score: 1.0, method: 'exact' };
    }

    // Check if they belong to the same alias group
    for (const [groupName, aliases] of Object.entries(this.roleAliases)) {
      const matchesS1 = aliases.some(alias => s1.includes(alias) || alias.includes(s1));
      const matchesS2 = aliases.some(alias => s2.includes(alias) || alias.includes(s2));
      if (matchesS1 && matchesS2) {
        const confidence = s1.includes('software') && s2.includes('sde') ? 0.95 : 0.92;
        return { score: confidence, method: 'alias mapping' };
      }
    }

    // Fallback: character bigram Dice's Coefficient
    const getBigrams = (str: string) => {
      const bigrams = new Set<string>();
      for (let i = 0; i < str.length - 1; i++) {
        bigrams.add(str.slice(i, i + 2));
      }
      return bigrams;
    };

    const b1 = getBigrams(s1);
    const b2 = getBigrams(s2);

    if (b1.size === 0 || b2.size === 0) {
      return { score: 0.0, method: 'bigram overlap' };
    }

    let intersection = 0;
    for (const b of b1) {
      if (b2.has(b)) {
        intersection++;
      }
    }

    const dice = (2.0 * intersection) / (b1.size + b2.size);
    const score = Math.round(dice * 100) / 100;
    return { score, method: 'fuzzy matching' };
  }

  private normalizeLocation(loc: string): string {
    let l = loc.toLowerCase().trim();
    l = l.replace(/[^a-z0-9\s]/g, '');

    for (const [key, normalized] of Object.entries(this.locationSynonyms)) {
      if (l === key || l.includes(key)) {
        return normalized;
      }
    }
    return l;
  }

  /**
   * Stage 3: Hard Filter Engine (Mandatory constraints check)
   */
  private applyHardFilters(profile: UserProfile, reqs: JobRequirements, jobTitle: string, jobDescription: string, jobCompany = 'Unknown'): boolean {
    const titleLower = jobTitle.toLowerCase();
    const descLower = jobDescription.toLowerCase();

    // 1. Role / Search Term Filter using role-family taxonomy and similarity fallback
    let titlePass = true;
    if (profile.preferredRoles && profile.preferredRoles.length > 0) {
      titlePass = profile.preferredRoles.some(role => {
        const queryFamily = detectFamily(role);
        const jobFamily = detectFamily(jobTitle);

        let pass = false;
        let reason = 'family_mismatch';

        if (queryFamily && jobFamily) {
          if (queryFamily === jobFamily) {
            pass = true;
            reason = 'same_family';
          } else if (isAncestor(queryFamily, jobFamily)) {
            pass = true;
            reason = 'ancestor';
          }
        }

        if (!pass) {
          const { score } = this.computeStringSimilarity(jobTitle, role);
          if (score >= 0.50) {
            pass = true;
            reason = 'similarity_match';
          }
        }

        this.writeDetailedMatchLog(`
User Preference:
${role}

Detected Family:
${queryFamily || 'None'}

Job Title:
${jobTitle}

Detected Family:
${jobFamily || 'None'}

Decision:
${pass ? 'PASS' : 'REJECT'}

Reason:
${reason}
`);

        return pass;
      });
    }

    // 2. Seniority & Experience Filter
    let minYearsRequired = reqs.experienceRequired || 0;
    let maxYearsRequired = 100;
    
    const textToScan = titleLower + ' ' + descLower;

    if (
      /\b(principal|architect|director|vp|head|vice president|ic5|ic6|l7|l8)\b/i.test(titleLower) ||
      /\b(career level - ic5|career level - ic6|level 7|level 8)\b/i.test(textToScan)
    ) {
      minYearsRequired = Math.max(minYearsRequired, 8);
    } else if (
      /\b(lead|manager|staff|engineering lead|tech lead|ic4|l6)\b/i.test(titleLower) ||
      /\b(career level - ic4|level 6)\b/i.test(textToScan)
    ) {
      minYearsRequired = Math.max(minYearsRequired, 6);
    } else if (
      /\b(senior|sr\b|sr\.|\biii\b|sde 3|sde iii|sde-3|sde-iii|developer 3|ic3|l5)\b/i.test(titleLower) ||
      /\b(career level - ic3|level 5)\b/i.test(textToScan)
    ) {
      minYearsRequired = Math.max(minYearsRequired, 5);
    } else if (
      /\b(mid|intermediate|sde 2|sde ii|sde-2|sde-ii|developer 2|ic2|l4)\b/i.test(titleLower) ||
      /\b(career level - ic2|level 4)\b/i.test(textToScan)
    ) {
      minYearsRequired = Math.max(minYearsRequired, 2);
      maxYearsRequired = 5;
    } else if (
      /\b(intern|internship|fresher|entry level|associate|graduate|trainee|sde 1|sde i|sde-1|sde-i|developer 1|ic1|l3)\b/i.test(titleLower) ||
      /\b(career level - ic1|level 3)\b/i.test(textToScan)
    ) {
      minYearsRequired = 0;
      maxYearsRequired = 2;
    }

    const yearsMatch = textToScan.match(/\b(\d+)\s*\+?\s*years?\s+(?:of\s+)?experience\b/i);
    if (yearsMatch) {
      const explicitYears = parseInt(yearsMatch[1], 10);
      minYearsRequired = Math.max(minYearsRequired, explicitYears);
    }

    const candidateYears = profile.experienceYears;
    let experiencePass = true;
    if (candidateYears < minYearsRequired) {
      experiencePass = false;
    }
    if (candidateYears >= 5 && maxYearsRequired <= 2) {
      experiencePass = false;
    }

    // 3. Remote & Location constraint checks
    const candidateLocations = (profile.preferences.locations || [])
      .map(loc => loc.trim().toLowerCase())
      .filter(Boolean);
    const isCandidateOpenToRemote = !!profile.preferences.remote;
    
    const jobLocLower = (reqs.location || '').toLowerCase();
    const isJobRemote = !!reqs.remoteAllowed || jobLocLower.includes('remote') || descLower.includes('remote');

    let remotePass = true;
    if (!isCandidateOpenToRemote && isJobRemote) {
      // If the candidate prefers on-site/hybrid (remote: false), we only fail the remote check
      // if the job does not have a physical location matching their preferred locations.
      if (candidateLocations.length > 0) {
        const normJobLoc = this.normalizeLocation(jobLocLower);
        const hasPhysicalMatch = candidateLocations.some(prefLoc => {
          const normPrefLoc = this.normalizeLocation(prefLoc);
          return normJobLoc.includes(normPrefLoc) || normPrefLoc.includes(normJobLoc);
        });
        if (!hasPhysicalMatch) {
          remotePass = false;
        }
      }
    }

    let locationPass = true;
    if (candidateLocations.length > 0) {
      const normJobLoc = this.normalizeLocation(jobLocLower);
      const hasPhysicalMatch = candidateLocations.some(prefLoc => {
        const normPrefLoc = this.normalizeLocation(prefLoc);
        return normJobLoc.includes(normPrefLoc) || normPrefLoc.includes(normJobLoc);
      });

      if (!hasPhysicalMatch) {
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
              locationPass = false;
            }
          } else if (isCandidateInCanada) {
            if (jobLocLower.includes('usa') || jobLocLower.includes('united states') || jobLocLower.includes('india') || jobLocLower.includes('uk') || jobLocLower.includes('united kingdom') || jobLocLower.includes('europe') || jobLocLower.includes('vancouver') || jobLocLower.includes('bc') || jobLocLower.includes('alberta')) {
              locationPass = false;
            }
          } else if (isCandidateInUS) {
            if (jobLocLower.includes('india') || jobLocLower.includes('canada') || jobLocLower.includes('uk') || jobLocLower.includes('united kingdom') || jobLocLower.includes('europe')) {
              locationPass = false;
            }
          }
        } else {
          locationPass = false;
        }
      }
    } else {
      if (!isCandidateOpenToRemote && isJobRemote) {
        locationPass = false;
      }
    }

    // 4. Employment Type constraint check
    let employmentPass = true;
    if (profile.preferences.employmentTypes && profile.preferences.employmentTypes.length > 0) {
      const jobEmpLower = reqs.employmentType.toLowerCase();
      employmentPass = profile.preferences.employmentTypes.some(type => 
        jobEmpLower.includes(type.toLowerCase()) || type.toLowerCase().includes(jobEmpLower)
      );
    }

    const isApproved = titlePass && locationPass && employmentPass && experiencePass && remotePass;

    const rejectReasons: string[] = [];
    if (!titlePass) rejectReasons.push('TITLE_MISMATCH');
    if (!locationPass) rejectReasons.push('LOCATION_MISMATCH');
    if (!experiencePass) rejectReasons.push('EXPERIENCE_MISMATCH');
    if (!employmentPass) rejectReasons.push('EMPLOYMENT_MISMATCH');
    if (!remotePass) rejectReasons.push('REMOTE_MISMATCH');

    // Experience checks tracing values
    const gradYearMatch = (profile.education || []).join(' ').match(/\b(19|20)\d{2}\b/);
    const graduationYear = gradYearMatch ? gradYearMatch[0] : 'None';
    
    // Calculate seniority
    let seniority = 'Junior';
    if (profile.experienceYears >= 5) {
      seniority = 'Senior';
    } else if (profile.experienceYears >= 2) {
      seniority = 'Mid';
    }

    this.writeDetailedMatchLog(`
================================================
Job
title: ${jobTitle}
company: ${jobCompany}
location: ${reqs.location || 'Unknown'}
employment_type: ${reqs.employmentType || 'Unknown'}
required_experience: ${minYearsRequired}

User Profile
canonical_role: ${profile.preferredRoles[0] || 'None'}
target_titles: ${JSON.stringify(profile.preferredRoles || [])}
experience_years: ${profile.experienceYears}
locations: ${JSON.stringify(profile.preferences.locations || [])}
employmentTypes: ${JSON.stringify(profile.preferences.employmentTypes || [])}
remote: ${profile.preferences.remote}

Checks
titlePass: ${titlePass}
locationPass: ${locationPass}
employmentPass: ${employmentPass}
experiencePass: ${experiencePass}
remotePass: ${remotePass}

Final Decision
${isApproved ? 'APPROVED' : 'REJECTED'}

Reject Reasons
${rejectReasons.join('\n') || 'None'}
================================================
`);

    console.log(`[DECISION] ${isApproved ? 'ACCEPT' : 'REJECT'} | Reason: ${rejectReasons.join(', ') || 'None'} | Title: ${jobTitle}`);

    if (!isApproved) {
      if (!titlePass) this.stats.titleReject++;
      if (!locationPass) this.stats.locationReject++;
      if (!experiencePass) this.stats.experienceReject++;
      if (!employmentPass) this.stats.employmentReject++;
      if (!remotePass) this.stats.remoteReject++;
      
      const onlyExperienceFailed = titlePass && locationPass && employmentPass && remotePass && !experiencePass;
      if (onlyExperienceFailed) {
        this.stats.solelyExperienceReject++;
      }
    }

    return isApproved;
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
