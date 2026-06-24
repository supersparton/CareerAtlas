import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseService } from '../vector-store/database.service';
import { UserProfile } from '../profile/profile.service';
import { JobRequirements } from '../intelligence/job-intelligence.service';
import { Job } from '../discovery/discovery.service';
import { QdrantService } from '../vector-store/qdrant.service';
import {
  ROLE_ONTOLOGY,
  detectFamily,
  detectSubfamily,
  calculateFamilySimilarity,
  calculateSubfamilySimilarity,
} from './roleTaxonomy';

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

  // Explainability outputs
  overallScore: number;
  requiredSkillScore: number;
  preferredSkillScore: number;
  domainScore: number;
  locationScore: number;
  matchedSkills: string[];
  missingSkills: string[];
  explanation: string;
  eligible: boolean;

  // Compatibility fields
  eligibility: string;
  familyScore: number;
  subFamilyScore: number;
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

  // Pre-compiled skill index for O(1) ontology lookups
  private static readonly SKILL_INDEX: Record<string, { family: string; subfamily: string }> = (() => {
    const index: Record<string, { family: string; subfamily: string }> = {};
    for (const [family, subfamilies] of Object.entries(ROLE_ONTOLOGY)) {
      for (const [subfamily, skills] of Object.entries(subfamilies)) {
        for (const skill of skills) {
          const cleanSkill = skill.toLowerCase().trim().replace(/[^a-z0-9\s#\+\.]/g, '');
          index[cleanSkill] = { family, subfamily };
        }
      }
    }
    return index;
  })();

  private stats = {
    titleReject: 0,
    locationReject: 0,
    experienceReject: 0,
    employmentReject: 0,
    remoteReject: 0,
    solelyExperienceReject: 0,
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

  constructor(
    private readonly db: DatabaseService,
    private readonly qdrantService: QdrantService,
  ) {}

  /**
   * Main Orchestrator for Job Recommendation matching pipeline.
   */
  async matchAndRankJobs(userId: number, limit = 20): Promise<RankedJob[]> {
    this.logger.log(`[MATCHING] Running semantic recommendation matching for user ID: ${userId}...`);
    
    // 1. Fetch User Profile from database
    const profile = await this.getUserProfile(userId);
    if (!profile) {
      this.logger.error(`[MATCHING] User profile for ID ${userId} not found.`);
      return [];
    }

    console.log(`\n[TRACE] before_matching:\ncanonical_role: ${JSON.stringify(profile.preferredRoles)}\n`);

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
            criticalSkills: payload.criticalSkills || [],
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

    // 5. Compute scores and perform Hard Rejection & Priority-Weighted Ranking
    const rankedJobs: RankedJob[] = [];
    for (const { job, reqs, similarity } of filteredJobs) {
      try {
        const userFamilySub = this.determineFamilyAndSubfamily(profile.preferredRoles[0] || '', profile.skills);
        const jobFamilySub = this.determineFamilyAndSubfamily(job.title, reqs.requiredSkills);

        // A. Domain Fit Score
        const domainScore = this.calculateDomainScore(
          userFamilySub.family,
          userFamilySub.subfamily,
          jobFamilySub.family,
          jobFamilySub.subfamily
        );

        // B. Skill Scores
        const criticalSkillResult = this.calculateSkillScore(profile.skills, reqs.criticalSkills || []);
        const requiredSkillResult = this.calculateSkillScore(profile.skills, reqs.requiredSkills);
        const preferredSkillResult = this.calculateSkillScore(profile.skills, reqs.preferredSkills);

        // --- STAGE 1: HARD REJECTION ---
        if (reqs.criticalSkills && reqs.criticalSkills.length > 0 && criticalSkillResult.score === 0) {
          this.logger.log(`[MATCHING] Candidate ${userId} rejected for job ${job.jobId} due to missing critical skills: ${criticalSkillResult.missing.join(', ')}`);
          continue;
        }

        if (reqs.requiredSkills.length > 0 && requiredSkillResult.score < 20) {
          this.logger.log(`[MATCHING] Candidate ${userId} rejected for job ${job.jobId} due to low required skills match: ${requiredSkillResult.score}%`);
          continue;
        }

        // C. Experience Match Score
        const experienceResult = this.computeExperienceScore(profile.experienceYears, reqs.experienceRequired);

        // D. Location Match Score
        const locationScore = this.calculateLocationScore(profile, reqs);

        // E. Semantic Match (using the initial Qdrant cosine similarity score directly)
        const semanticScore = Math.round(Math.max(0, Math.min(100, similarity * 100)));

        // F. Education Match
        const educationResult = this.computeEducationScore(profile.education, reqs.educationRequirements);

        // --- STAGE 2: PRIORITY-WEIGHTED RANKING ---
        // Weights:
        // - Required Skill Match: 45%
        // - Domain Score (combines family/subfamily matches): 35%
        // - Experience Match: 10%
        // - Location Match: 5%
        // - Preferred Skill Match: 5%
        const overallScore = Math.round(
          requiredSkillResult.score * 0.45 +
          domainScore * 0.35 +
          experienceResult.score * 0.10 +
          locationScore * 0.05 +
          preferredSkillResult.score * 0.05
        );

        // Generate explainability text reason
        let explanation = '';
        const missingRequired = requiredSkillResult.missing;
        const missingPreferred = preferredSkillResult.missing;
        const userDomainText = userFamilySub.subfamily || userFamilySub.family || 'software';

        if (missingRequired.length === 0 && missingPreferred.length === 0) {
          explanation = `Candidate has a strong background in ${userDomainText} with a perfect skill match.`;
        } else if (missingPreferred.length > 0) {
          explanation = `Candidate has ${userDomainText} experience, but lacks preferred skills like: ${missingPreferred.join(', ')}.`;
        } else {
          explanation = `Candidate has ${userDomainText} experience with good matching skills, but lacks required: ${missingRequired.join(', ')}.`;
        }

        const familySim = calculateFamilySimilarity(userFamilySub.family, jobFamilySub.family);
        const familyScore = familySim * 100;

        const subFamilySim = calculateSubfamilySimilarity(
          userFamilySub.family,
          userFamilySub.subfamily,
          jobFamilySub.family,
          jobFamilySub.subfamily
        );
        const subFamilyScore = subFamilySim * 100;

        rankedJobs.push({
          job,
          finalScore: overallScore,
          skillScore: Math.round((requiredSkillResult.score + preferredSkillResult.score) / 2),
          semanticScore,
          experienceScore: experienceResult.score,
          educationScore: educationResult.score,
          reasoning: explanation,
          overallScore,
          requiredSkillScore: requiredSkillResult.score,
          preferredSkillScore: preferredSkillResult.score,
          domainScore,
          locationScore,
          matchedSkills: [
            ...criticalSkillResult.matched,
            ...requiredSkillResult.matched,
            ...preferredSkillResult.matched
          ],
          missingSkills: [
            ...criticalSkillResult.missing,
            ...requiredSkillResult.missing,
            ...preferredSkillResult.missing
          ],
          explanation,
          eligible: true,
          eligibility: 'PASS',
          familyScore,
          subFamilyScore,
        });
      } catch (err) {
        this.logger.error(`[MATCHING] Error scoring job ${job.jobId}: ${err.message}`);
      }
    }

    // Sort descending by overallScore
    const sorted = rankedJobs.sort((a, b) => b.overallScore - a.overallScore);
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

  private normalizeSkillName(skill: string): string {
    if (!skill) return '';
    const clean = skill.toLowerCase().trim().replace(/[^a-z0-9\s#\+\.]/g, '');
    return this.SKILL_MAP[clean] || clean;
  }

  /**
   * Reusable unified skill scoring method using O(1) SKILL_INDEX.
   * Completely avoids fuzzy string similarity, utilizing ontology relationships only.
   */
  private calculateSkillScore(
    candidateSkills: string[],
    targetSkills: string[],
    options?: { isCritical?: boolean }
  ): { score: number; matched: string[]; missing: string[] } {
    if (!targetSkills || targetSkills.length === 0) {
      return { score: 100, matched: [], missing: [] };
    }

    const normalizedCandidate = candidateSkills.map(s => this.normalizeSkillName(s));
    
    let totalMatchValue = 0;
    const matched: string[] = [];
    const missing: string[] = [];

    for (const targetSkill of targetSkills) {
      const normTarget = this.normalizeSkillName(targetSkill);
      let bestMatchVal = 0;

      // 1. Check exact/normalized match
      if (normalizedCandidate.includes(normTarget)) {
        bestMatchVal = 1.0;
      } else {
        // 2. Check ontology match
        const groupTarget = MatchingService.SKILL_INDEX[normTarget];
        if (groupTarget) {
          for (const candSkill of normalizedCandidate) {
            const groupCand = MatchingService.SKILL_INDEX[candSkill];
            if (groupCand) {
              if (groupTarget.family === groupCand.family && groupTarget.subfamily === groupCand.subfamily) {
                bestMatchVal = Math.max(bestMatchVal, 0.8);
              } else if (groupTarget.family === groupCand.family) {
                bestMatchVal = Math.max(bestMatchVal, 0.4);
              }
            }
          }
        }
      }

      totalMatchValue += bestMatchVal;
      if (bestMatchVal >= 0.8) {
        matched.push(targetSkill);
      } else {
        missing.push(targetSkill);
      }
    }

    const score = Math.round((totalMatchValue / targetSkills.length) * 100);
    return { score, matched, missing };
  }

  /**
   * Domain fit score based on combined family/subfamily match signals.
   * Same Subfamily = 100, Same Family = 60, Different Family = 0
   */
  private calculateDomainScore(
    userFamily: string | null,
    userSubfamily: string | null,
    jobFamily: string | null,
    jobSubfamily: string | null
  ): number {
    if (!userFamily || !jobFamily) {
      return 0;
    }
    if (userFamily === jobFamily) {
      if (userSubfamily === jobSubfamily) {
        return 100;
      }
      return 60;
    }
    return 0;
  }

  /**
   * Infers dominant family/subfamily using precompiled SKILL_INDEX.
   */
  private determineFamilyAndSubfamily(text: string, skills: string[]): { family: string | null; subfamily: string | null } {
    let detectedFamily = detectFamily(text);
    let detectedSubfamily = detectSubfamily(text);

    // If title detection is software or null, look at the skills
    if (!detectedFamily || detectedFamily === 'software' || !detectedSubfamily) {
      const familyCounts: Record<string, number> = {};
      const subfamilyCounts: Record<string, number> = {};

      for (const skill of skills) {
        const normSkill = this.normalizeSkillName(skill);
        const group = MatchingService.SKILL_INDEX[normSkill];
        if (group) {
          familyCounts[group.family] = (familyCounts[group.family] || 0) + 1;
          subfamilyCounts[group.subfamily] = (subfamilyCounts[group.subfamily] || 0) + 1;
        }
      }

      let bestSkillsFamily: string | null = null;
      let maxFamilyCount = 0;
      for (const [fam, cnt] of Object.entries(familyCounts)) {
        if (cnt > maxFamilyCount) {
          maxFamilyCount = cnt;
          bestSkillsFamily = fam;
        }
      }

      let bestSkillsSubfamily: string | null = null;
      let maxSubfamilyCount = 0;
      for (const [sub, cnt] of Object.entries(subfamilyCounts)) {
        if (cnt > maxSubfamilyCount) {
          maxSubfamilyCount = cnt;
          bestSkillsSubfamily = sub;
        }
      }

      if (!detectedFamily || detectedFamily === 'software') {
        detectedFamily = bestSkillsFamily || detectedFamily || null;
      }
      if (!detectedSubfamily) {
        detectedSubfamily = bestSkillsSubfamily || null;
      }
    }

    return { family: detectedFamily, subfamily: detectedSubfamily };
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
   * Location Match Score on 0 to 100 scale.
   */
  private calculateLocationScore(profile: UserProfile, reqs: JobRequirements): number {
    const candidateLocations = (profile.preferences.locations || [])
      .map(loc => loc.trim().toLowerCase())
      .filter(Boolean);
    const isCandidateOpenToRemote = !!profile.preferences.remote;
    const jobLocLower = (reqs.location || '').toLowerCase();
    const isJobRemote = !!reqs.remoteAllowed || jobLocLower.includes('remote');

    if (candidateLocations.length === 0) {
      if (isCandidateOpenToRemote) return 100;
      return isJobRemote ? 50 : 100;
    }

    const normJobLoc = this.normalizeLocation(jobLocLower);
    const hasPhysicalMatch = candidateLocations.some(prefLoc => {
      const normPrefLoc = this.normalizeLocation(prefLoc);
      return normJobLoc.includes(normPrefLoc) || normPrefLoc.includes(normJobLoc);
    });

    if (hasPhysicalMatch) {
      return 100;
    }

    if (isJobRemote && isCandidateOpenToRemote) {
      // Check for country alignment
      const isCandidateInIndia = candidateLocations.some(loc => 
        loc.includes('india') || loc.includes('bangalore') || loc.includes('bengaluru') || loc.includes('ahmedabad') || loc.includes('noida') || loc.includes('delhi') || loc.includes('mumbai') || loc.includes('pune')
      );
      const isCandidateInCanada = candidateLocations.some(loc => 
        loc.includes('canada') || loc.includes('ontario') || loc.includes('toronto') || loc.includes('vancouver') || loc.includes('bc') || loc.includes('alberta')
      );
      const isCandidateInUS = candidateLocations.some(loc => 
        loc.includes('usa') || loc.includes('united states') || loc.includes('california') || loc.includes('new york') || loc.includes('texas') || loc.includes('sf') || loc.includes('chicago')
      );

      let countryMismatch = false;
      if (isCandidateInIndia) {
        if (jobLocLower.includes('usa') || jobLocLower.includes('united states') || jobLocLower.includes('canada') || jobLocLower.includes('uk') || jobLocLower.includes('united kingdom') || jobLocLower.includes('europe') || jobLocLower.includes('latam')) {
          countryMismatch = true;
        }
      } else if (isCandidateInCanada) {
        if (jobLocLower.includes('usa') || jobLocLower.includes('united states') || jobLocLower.includes('india') || jobLocLower.includes('uk') || jobLocLower.includes('united kingdom') || jobLocLower.includes('europe')) {
          countryMismatch = true;
        }
      } else if (isCandidateInUS) {
        if (jobLocLower.includes('india') || jobLocLower.includes('canada') || jobLocLower.includes('uk') || jobLocLower.includes('united kingdom') || jobLocLower.includes('europe')) {
          countryMismatch = true;
        }
      }

      return countryMismatch ? 20 : 100;
    }

    if (isJobRemote && !isCandidateOpenToRemote) {
      return 30; // Candidate prefers on-site, job is remote
    }

    return 0; // On-site job, no physical location match
  }

  /**
   * Stage 3: Hard Filter Engine (Mandatory constraints check)
   * Focuses on location, experience, remote, and employment type alignment,
   * avoiding title false positives which are resolved via ontology in matching.
   */
  private applyHardFilters(profile: UserProfile, reqs: JobRequirements, jobTitle: string, jobDescription: string, jobCompany = 'Unknown'): boolean {
    const titleLower = jobTitle.toLowerCase();
    const descLower = jobDescription.toLowerCase();

    // 1. Seniority & Experience Filter
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

    if (!experiencePass) {
      this.stats.experienceReject++;
      return false;
    }

    // 2. Remote & Location constraint checks
    const candidateLocations = (profile.preferences.locations || [])
      .map(loc => loc.trim().toLowerCase())
      .filter(Boolean);
    const isCandidateOpenToRemote = !!profile.preferences.remote;
    
    const jobLocLower = (reqs.location || '').toLowerCase();
    const isJobRemote = !!reqs.remoteAllowed || jobLocLower.includes('remote') || descLower.includes('remote');

    let remotePass = true;
    if (!isCandidateOpenToRemote && isJobRemote) {
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

    if (!remotePass) {
      this.stats.remoteReject++;
      return false;
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
            if (jobLocLower.includes('usa') || jobLocLower.includes('united states') || jobLocLower.includes('india') || jobLocLower.includes('uk') || jobLocLower.includes('united kingdom') || jobLocLower.includes('europe')) {
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

    if (!locationPass) {
      this.stats.locationReject++;
      return false;
    }

    // 3. Employment Type constraint check
    let employmentPass = true;
    if (profile.preferences.employmentTypes && profile.preferences.employmentTypes.length > 0) {
      const jobEmpLower = reqs.employmentType.toLowerCase();
      employmentPass = profile.preferences.employmentTypes.some(type => 
        jobEmpLower.includes(type.toLowerCase()) || type.toLowerCase().includes(jobEmpLower)
      );
    }

    if (!employmentPass) {
      this.stats.employmentReject++;
      return false;
    }

    return true;
  }

  private computeExperienceScore(candidateYears: number, requiredYears: number): ExperienceScore {
    if (candidateYears >= requiredYears) {
      return { requiredYears, candidateYears, score: 100 };
    }
    // Underqualification deduction
    const deficit = requiredYears - candidateYears;
    const score = Math.max(0, Math.round(100 - deficit * 25));
    return { requiredYears, candidateYears, score };
  }

  private computeEducationScore(candidateEdu: string[], requiredEdu: string[]): EducationScore {
    if (!requiredEdu || requiredEdu.length === 0) {
      return { score: 100 };
    }
    if (!candidateEdu || candidateEdu.length === 0) {
      return { score: 50 };
    }

    const normRequired = requiredEdu.join(' ').toLowerCase();
    const isDegreeRequired = /bachelor|b\.tech|b\.e\.|m.tech|m\.s\.|phd|doctorate|degree/i.test(normRequired);

    if (!isDegreeRequired) {
      return { score: 100 };
    }

    const eduMatches = candidateEdu.some(candEdu => {
      const candEduLower = candEdu.toLowerCase();
      if (normRequired.includes('phd') && candEduLower.includes('phd')) return true;
      if (normRequired.includes('master') && (candEduLower.includes('master') || candEduLower.includes('m.tech') || candEduLower.includes('m.s.'))) return true;
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
      
      const user = userRes.rows[0];
      const pref = prefRes.rows[0];
      const skills = skillsRes.rows.map(r => r.skill);

      return {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        skills,
        experienceYears: pref.experience_years,
        education: ['B.Tech in Computer Science', 'Bachelor Degree'],
        projects: [],
        achievements: [],
        preferredRoles: pref.preferred_roles,
        preferences: {
          locations: pref.locations,
          remote: pref.remote,
          employmentTypes: pref.employment_types,
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
            criticalSkills: payload.criticalSkills || [],
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
