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
  TransferabilityTier,
  getTransferableFactor,
} from './roleTaxonomy';
import type {
  SkillScore,
  SemanticScore,
  ExperienceScore,
  EducationScore,
  RankedJob,
  EvidenceCard,
  EvidenceAnalyzer,
} from './interfaces';
import {
  MATCHING_PENALTIES,
  DEFAULT_MATCHING_CONFIG,
  MatchingConfig,
} from './constants';
import { TechnicalCompetenceAnalyzer } from "./analyzers/technical.analyzer";
import { ExperienceSeniorityAnalyzer } from "./analyzers/experience.analyzer";
import { SemanticAnalyzer } from "./analyzers/semantic.analyzer";
import { LogisticsAnalyzer } from "./analyzers/logistics.analyzer";

export { MATCHING_PENALTIES, DEFAULT_MATCHING_CONFIG };
export type {
  MatchingConfig,
  SkillScore,
  SemanticScore,
  ExperienceScore,
  EducationScore,
  RankedJob,
  EvidenceCard,
  EvidenceAnalyzer,
};

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

  private readonly config: MatchingConfig;

  private readonly analyzers: EvidenceAnalyzer[] = [
    new TechnicalCompetenceAnalyzer(this),
    new ExperienceSeniorityAnalyzer(),
    new SemanticAnalyzer(),
    new LogisticsAnalyzer(this),
  ];

  constructor(
    private readonly db: DatabaseService,
    private readonly qdrantService: QdrantService,
  ) {
    this.config = { ...DEFAULT_MATCHING_CONFIG };
    if (process.env.MATCHING_CONFIG_OVERRIDE_JSON) {
      try {
        const override = JSON.parse(process.env.MATCHING_CONFIG_OVERRIDE_JSON);
        this.config = this.deepMerge(this.config, override);
        this.logger.log('Successfully loaded MatchingConfig overrides from MATCHING_CONFIG_OVERRIDE_JSON');
      } catch (err) {
        this.logger.error(`Failed to parse MATCHING_CONFIG_OVERRIDE_JSON: ${err.message}`);
      }
    }
  }

  private deepMerge(target: any, source: any): any {
    if (!source) return target;
    const output = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        output[key] = this.deepMerge(target[key] || {}, source[key]);
      } else {
        output[key] = source[key];
      }
    }
    return output;
  }

  /**
   * Main Orchestrator for Job Recommendation matching pipeline.
   */
  async matchAndRankJobs(userId: number, limit = 20): Promise<RankedJob[]> {
    this.clearDetailedMatchLog();
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
    } catch (vectorErr: any) {
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
    } catch (qdrantErr: any) {
      this.logger.error(`[MATCHING] Qdrant search failed: ${qdrantErr.message}`);
      return [];
    }

    this.logger.log(`[MATCHING] Loaded ${jobsWithReqs.length} semantically similar jobs from Qdrant.`);

    // DEBUG 1: After semantic retrieval
    this.logger.log(`[DEBUG 1] Top retrieved jobs from semantic search:`);
    jobsWithReqs.slice(0, 20).forEach((item, idx) => {
      this.logger.log(`  #${idx + 1}: Title: "${item.job.title}" | Company: "${item.job.company}" | Semantic Similarity: ${item.similarity.toFixed(4)} | Required Experience: ${item.reqs.experienceRequired} years`);
    });

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

    // DEBUG 3: Before ranking - Log the complete feature vector
    this.logger.log(`[DEBUG 3] Candidate Profile Feature Vector: ${JSON.stringify({
      id: profile.id,
      fullName: profile.fullName,
      skills: profile.skills,
      experienceYears: profile.experienceYears,
      education: profile.education,
      projects: profile.projects,
      achievements: profile.achievements,
      preferredRoles: profile.preferredRoles,
      preferences: profile.preferences
    })}`);
    for (const { job, reqs, similarity } of filteredJobs) {
      try {
        const userFamilySub = this.determineFamilyAndSubfamily(profile.preferredRoles[0] || '', profile.skills);
        const jobFamilySub = this.determineFamilyAndSubfamily(job.title, reqs.requiredSkills);

        const domainScore = this.calculateDomainScore(
          userFamilySub.family,
          userFamilySub.subfamily,
          jobFamilySub.family,
          jobFamilySub.subfamily
        );

        const criticalSkillResult = this.calculateSkillScoreWithTransferability(profile.skills, reqs.criticalSkills || [], this.config);
        const requiredSkillResult = this.calculateSkillScoreWithTransferability(profile.skills, reqs.requiredSkills, this.config);
        const preferredSkillResult = this.calculateSkillScoreWithTransferability(profile.skills, reqs.preferredSkills, this.config);

        // --- STAGE 1: HARD REJECTION ---
        if (this.config.matching.useHardFilters) {
          if (reqs.criticalSkills && reqs.criticalSkills.length > 0 && criticalSkillResult.score === 0) {
            this.logger.log(`[MATCHING] Candidate ${userId} rejected for job ${job.jobId} due to missing critical skills: ${criticalSkillResult.missing.join(', ')}`);
            continue;
          }

          if (reqs.requiredSkills.length > 0 && requiredSkillResult.score < 20) {
            this.logger.log(`[MATCHING] Candidate ${userId} rejected for job ${job.jobId} due to low required skills match: ${requiredSkillResult.score}%`);
            continue;
          }
        }

        // --- STAGE 2: PLUGIN-BASED EVIDENCE ACCUMULATION ---
        const cards: EvidenceCard[] = [];
        const context = { similarity, config: this.config };
        const seenDescriptions = new Set<string>();
        const analyzerConfidences: Record<string, number> = {};

        for (const analyzer of this.analyzers) {
          const result = analyzer.analyze(profile, reqs, job, context);
          analyzerConfidences[analyzer.name] = result.confidence;
          for (const card of result.cards) {
            if (!seenDescriptions.has(card.description)) {
              seenDescriptions.add(card.description);
              cards.push(card);
            }
          }
        }

        // 3-tier score aggregation
        const baseScore = cards
          .filter(c => c.type === 'ADDITIVE')
          .reduce((sum, c) => sum + c.val, 0);

        const multiplier = cards
          .filter(c => c.type === 'MULTIPLIER')
          .reduce((product, c) => product * c.val, 1.0);

        const subtractive = cards
          .filter(c => c.type === 'SUBTRACTIVE')
          .reduce((sum, c) => sum + c.val, 0);

        const overallScore = Math.max(0, Math.round(baseScore * multiplier - subtractive));

        // --- STAGE 3: CONFIDENCE PROPAGATION MODEL ---
        const weights = this.config.matching.weights;
        const totalWeight = (weights.technical || 0) + (weights.experience || 0) + (weights.semantic || 0) + (weights.logistics || 0);
        const wTech = totalWeight > 0 ? (weights.technical || 0) / totalWeight : 0.5;
        const wExp = totalWeight > 0 ? (weights.experience || 0) / totalWeight : 0.2;
        const wSem = totalWeight > 0 ? (weights.semantic || 0) / totalWeight : 0.2;
        const wLog = totalWeight > 0 ? (weights.logistics || 0) / totalWeight : 0.1;

        const cTech = analyzerConfidences['TechnicalCompetence'] !== undefined ? analyzerConfidences['TechnicalCompetence'] : 1.0;
        const cExp = analyzerConfidences['ExperienceSeniority'] !== undefined ? analyzerConfidences['ExperienceSeniority'] : 1.0;
        const cSem = analyzerConfidences['Semantic'] !== undefined ? analyzerConfidences['Semantic'] : 1.0;
        const cLog = analyzerConfidences['Logistics'] !== undefined ? analyzerConfidences['Logistics'] : 1.0;

        // Base Trust (Tb)
        const baseTrust = (cTech * wTech) + (cExp * wExp) + (cSem * wSem) + (cLog * wLog);

        // Evidence Richness Coefficient (Rc)
        const rConf = this.config.confidence.richnessThresholds;
        let richnessScore = 0;

        const skillsCount = profile.skills ? profile.skills.length : 0;
        const skillsCompleteness = skillsCount >= 5 ? 1.0 : (skillsCount / 5);
        richnessScore += rConf.skillsWeight * skillsCompleteness;

        const expYears = profile.experienceYears || 0;
        const expCompleteness = expYears >= 1 ? 1.0 : 0.0;
        richnessScore += rConf.experienceWeight * expCompleteness;

        const projCount = profile.projects ? profile.projects.length : 0;
        const projCompleteness = projCount >= 1 ? 1.0 : 0.0;
        richnessScore += rConf.projectsWeight * projCompleteness;

        const eduCount = profile.education ? profile.education.length : 0;
        const eduCompleteness = eduCount >= 1 ? 1.0 : 0.0;
        richnessScore += rConf.educationWeight * eduCompleteness;

        const achCount = profile.achievements ? profile.achievements.length : 0;
        const achCompleteness = achCount >= 1 ? 1.0 : 0.0;
        richnessScore += rConf.achievementsWeight * achCompleteness;

        const hasCert = profile.achievements && profile.achievements.some(a => /certif/i.test(a));
        const certCompleteness = hasCert ? 1.0 : 0.5;
        richnessScore += rConf.certificationsWeight * certCompleteness;

        let Rc = 1.0;
        if (richnessScore < rConf.minRichnessScore) {
          const diff = rConf.minRichnessScore - richnessScore;
          Rc = Math.max(0.5, 1.0 - diff);
        }

        // Consistency Multiplier (Mc)
        let Mc = 1.0;
        const hasLocationMismatch = cards.some(c => c.description.toLowerCase().includes('location mismatch'));
        const hasEmploymentMismatch = cards.some(c => c.description.toLowerCase().includes('employment type mismatch'));
        const hasCriticalMismatch = cards.some(c => c.description.toLowerCase().includes('missing critical skill'));
        const hasLowRequiredMismatch = cards.some(c => c.description.toLowerCase().includes('low required skills match'));
        const hasShortDescription = cards.some(c => c.description.toLowerCase().includes('short job description'));

        if (hasLocationMismatch) Mc *= 0.8;
        if (hasEmploymentMismatch) Mc *= 0.9;
        if (hasCriticalMismatch) Mc *= 0.7;
        if (hasLowRequiredMismatch) Mc *= 0.85;
        if (hasShortDescription) Mc *= 0.95;

        // Final Confidence Score (Cr)
        const confidenceScoreVal = Math.round(baseTrust * Rc * Mc * 100);
        const confidenceScore = Math.max(0, Math.min(100, confidenceScoreVal));

        const logMsg = `[CONFIDENCE ENGINE] Job: "${job.title}" (${job.company}) | Tb (Base Trust): ${baseTrust.toFixed(2)} | Rc (Richness): ${Rc.toFixed(2)} (raw: ${richnessScore.toFixed(2)}) | Mc (Consistency): ${Mc.toFixed(2)} (Loc: ${hasLocationMismatch}, Emp: ${hasEmploymentMismatch}, Crit: ${hasCriticalMismatch}, Req: ${hasLowRequiredMismatch}, Short: ${hasShortDescription}) | Cr (Final): ${confidenceScore}%`;
        this.logger.log(logMsg);
        this.writeDetailedMatchLog(logMsg);

        // Confidence Factors (Explainability)
        const positive: string[] = [];
        const negative: string[] = [];

        if (cTech >= 0.9) {
          positive.push("Direct skill match for required technologies.");
        }
        if (cExp === 1.0 && profile.experienceYears > 0) {
          positive.push("Complete work experience history.");
        }
        if (cLog === 1.0 && !hasLocationMismatch) {
          positive.push("Explicit physical location alignment.");
        }
        if (profile.projects && profile.projects.length > 0) {
          positive.push("Verified project experience.");
        }

        if (hasCriticalMismatch) {
          negative.push("Missing critical skill set.");
        }
        if (hasLocationMismatch) {
          negative.push("Location mismatch with preferred work locations.");
        }
        if (cExp < 0.8) {
          negative.push("Missing experience dates or unverified history.");
        }
        if (!profile.preferences.locations || profile.preferences.locations.length === 0) {
          negative.push("Ambiguous location preferences: Candidate listed no explicit preferred physical locations.");
        }
        if (hasEmploymentMismatch) {
          negative.push("Employment type mismatch.");
        }
        if (hasShortDescription) {
          negative.push("Evidence quality compromised due to short job description.");
        }
        if (Rc < 1.0) {
          negative.push("Sparse profile data across multiple evidence dimensions.");
        }

        // Generate clean plain-English fallback explanation
        const allMatched = Array.from(new Set([...criticalSkillResult.matched, ...requiredSkillResult.matched, ...preferredSkillResult.matched]));
        const allMissing = Array.from(new Set([...criticalSkillResult.missing, ...requiredSkillResult.missing, ...preferredSkillResult.missing]));
        
        let explanation = '';
        if (allMatched.length > 0) {
          explanation += `Matches your background in ${allMatched.slice(0, 4).join(', ')}. `;
        } else {
          explanation += `Strong alignment with candidate role preferences. `;
        }
        if (allMissing.length > 0) {
          explanation += `Additional growth area: ${allMissing.slice(0, 3).join(', ')}.`;
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

        const experienceResult = this.computeExperienceScore(profile.experienceYears, reqs.experienceRequired);
        const educationResult = this.computeEducationScore(profile.education, reqs.educationRequirements);
        const locationScore = this.calculateLocationScore(profile, reqs);
        const semanticScore = Math.round(Math.max(0, Math.min(100, similarity * 100)));

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
          matchedSkills: Array.from(new Set([
            ...criticalSkillResult.matched,
            ...requiredSkillResult.matched,
            ...preferredSkillResult.matched
          ])),
          missingSkills: Array.from(new Set([
            ...criticalSkillResult.missing,
            ...requiredSkillResult.missing,
            ...preferredSkillResult.missing
          ])),
          explanation,
          eligible: true,
          eligibility: 'PASS',
          familyScore,
          subFamilyScore,
          confidenceScore,
          confidenceFactors: { positive, negative }
        });

        // RE-CALCULATE METRICS FOR LOGGING & JSON
        const requiredSkills = reqs.requiredSkills || [];
        const preferredSkills = reqs.preferredSkills || [];
        const techConf = this.config.confidence.technical;
        let reqSkillsConf = techConf.exactMatch;
        let prefSkillsConf = techConf.exactMatch;
        let projectConf = techConf.exactMatch;

        if (requiredSkills.length > 0) {
          reqSkillsConf = requiredSkillResult.confidence !== undefined ? requiredSkillResult.confidence : techConf.exactMatch;
        }
        if (preferredSkills.length > 0) {
          prefSkillsConf = preferredSkillResult.confidence !== undefined ? preferredSkillResult.confidence : techConf.exactMatch;
        }

        const projectText = (profile.projects || []).join(' ').toLowerCase();
        let projectMatchCount = 0;
        const verifiedSkills: string[] = [];
        const uniqueSkills = new Set([...requiredSkills, ...preferredSkills]);
        for (const skill of uniqueSkills) {
          const normSkill = this.normalizeSkillName(skill);
          if (normSkill && projectText.includes(normSkill)) {
            projectMatchCount++;
            verifiedSkills.push(skill);
          }
        }
        const projectVal = Math.min(10, projectMatchCount * 2);
        if (projectVal > 0) {
          projectConf = techConf.projectInferredMatch;
        }

        const penaltiesObj: Record<string, number> = {};
        if (multiplier < 1.0) {
          penaltiesObj['experienceGap'] = -Math.round(baseScore * (1.0 - multiplier));
        }
        cards.filter(c => c.type === 'SUBTRACTIVE').forEach(c => {
          const desc = c.description.toLowerCase();
          if (desc.includes('critical skill')) {
            penaltiesObj['missingCriticalSkills'] = -c.val;
          } else if (desc.includes('location')) {
            penaltiesObj['locationMismatch'] = -c.val;
          } else if (desc.includes('employment')) {
            penaltiesObj['employmentMismatch'] = -c.val;
          } else if (desc.includes('description')) {
            penaltiesObj['shortDescription'] = -c.val;
          } else if (desc.includes('required skill')) {
            penaltiesObj['requiredSkillLowMatch'] = -c.val;
          } else {
            penaltiesObj[c.description] = -c.val;
          }
        });
        if (domainScore < 100) {
          penaltiesObj['domainMismatch'] = -Math.round((100 - domainScore) * 0.10);
        }

        const jobDebugJson = {
          job: job.title,
          semanticScore: parseFloat(similarity.toFixed(4)),
          technicalScore: parseFloat((requiredSkillResult.score / 100).toFixed(4)),
          experienceScore: parseFloat((experienceResult.score / 100).toFixed(4)),
          requiredSkillsScore: parseFloat((requiredSkillResult.score / 100).toFixed(4)),
          preferredSkillsScore: parseFloat((preferredSkillResult.score / 100).toFixed(4)),
          transferabilityScore: parseFloat((subFamilyScore / 100).toFixed(4)),
          projectScore: parseFloat((projectVal / 10).toFixed(4)),
          penalties: penaltiesObj,
          confidence: parseFloat((confidenceScore / 100).toFixed(4)),
          finalScore: parseFloat((overallScore / 100).toFixed(4)),
          recommended: overallScore >= (this.config.matching.useHardFilters ? 50 : 30)
        };

        // PRINT JSON object
        this.logger.log(`[JSON_INSTRUMENTATION] ${JSON.stringify(jobDebugJson)}`);

        // DEBUG 5: Score breakdown for every recommended/evaluated job
        this.logger.log(`[DEBUG 5] Job Score Breakdown for "${job.title}" (${job.company}):`);
        this.logger.log(`  - Semantic Analyzer (Similarity: ${similarity.toFixed(4)}, Contrib: +${Math.round(similarity * 30)} pts)`);
        this.logger.log(`  - Technical Competence Analyzer:`);
        this.logger.log(`    * Required Skills overlap: ${requiredSkillResult.score}% (Contrib: +${Math.round(requiredSkillResult.score * 0.40)} pts, Confidence: ${reqSkillsConf.toFixed(2)})`);
        this.logger.log(`    * Preferred Skills overlap: ${preferredSkillResult.score}% (Contrib: +${Math.round(preferredSkillResult.score * 0.10)} pts, Confidence: ${prefSkillsConf.toFixed(2)})`);
        this.logger.log(`    * Domain alignment score: ${domainScore}% (Contrib: +${Math.round(domainScore * 0.10)} pts)`);
        this.logger.log(`    * Projects scan matched: ${projectMatchCount} (Contrib: +${projectVal} pts, Confidence: ${projectConf.toFixed(2)})`);
        this.logger.log(`  - Experience & Seniority Analyzer:`);
        this.logger.log(`    * Candidate Years: ${profile.experienceYears} | Required Years: ${reqs.experienceRequired || 0}`);
        this.logger.log(`    * Multiplier: ${multiplier.toFixed(2)}`);
        this.logger.log(`  - Logistics Analyzer Penalties:`);
        cards.filter(c => c.type === 'SUBTRACTIVE').forEach(c => {
          this.logger.log(`    * Penalty: "${c.description}" (-${c.val} pts)`);
        });
        this.logger.log(`  - Final Confidence Score computation: Tb=${baseTrust.toFixed(2)}, Rc=${Rc.toFixed(2)}, Mc=${Mc.toFixed(2)} => Cr=${confidenceScore}%`);

      } catch (err: any) {
        this.logger.error(`[MATCHING] Error scoring job ${job.jobId}: ${err.message}`);
      }
    }

    // DEBUG 4: Before final recommendation - Log the exact weighted formula
    const exactFormula = `OverallScore = max(0, Math.round(baseScore * multiplier - subtractive)). Where baseScore = TechnicalScore(max 40) + PreferredSkillsScore(max 10) + DomainAlignment(max 10) + SemanticScore(max 30); multiplier = ExperienceSeniorityMultiplier; subtractive = ShortDescriptionPenalty + CriticalSkillsMismatchPenalty + RequiredSkillsLowMatchPenalty + LocationMismatchPenalty + EmploymentTypeMismatchPenalty`;
    this.logger.log(`[DEBUG 4] Exact Weighted Formula used: ${exactFormula}`);

    // Sort descending by overallScore and filter out matches below 30% (50% if useHardFilters)
    const scoreThreshold = this.config.matching.useHardFilters ? 50 : 30;
    const sorted = rankedJobs
      .filter((job) => job.overallScore >= scoreThreshold)
      .sort((a, b) => b.overallScore - a.overallScore);
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
    } catch (err: any) {
      // fallback
    }
  }

  private clearDetailedMatchLog() {
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
      fs.writeFileSync(logFile, '', 'utf8');
    } catch (err: any) {
      // fallback
    }
  }

  public normalizeSkillName(skill: string): string {
    if (!skill) return '';
    const clean = skill.toLowerCase().trim().replace(/[^a-z0-9\s#\+\.]/g, '');
    return this.SKILL_MAP[clean] || clean;
  }

  private calculateSkillScore(
    candidateSkills: string[],
    targetSkills: string[],
    options?: { isCritical?: boolean }
  ): { score: number; matched: string[]; missing: string[]; confidence?: number } {
    return this.calculateSkillScoreWithTransferability(candidateSkills, targetSkills, this.config);
  }

  public calculateSkillScoreWithTransferability(
    candidateSkills: string[],
    targetSkills: string[],
    config: MatchingConfig = DEFAULT_MATCHING_CONFIG
  ): { score: number; matched: string[]; missing: string[]; confidence: number } {
    if (!targetSkills || targetSkills.length === 0) {
      return { score: 0, matched: [], missing: [], confidence: 1.0 };
    }

    const individualCandidateSkills: string[] = [];
    for (const skillStr of candidateSkills) {
      const parts = skillStr.split(/[:,;\u2022\n\r\t]/);
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed) {
          individualCandidateSkills.push(trimmed);
        }
      }
    }
    const normalizedCandidate = individualCandidateSkills.map(s => this.normalizeSkillName(s));

    let totalMatchValue = 0;
    let totalConfidenceValue = 0;
    const matched: string[] = [];
    const missing: string[] = [];

    const techConf = config.confidence.technical;

    for (const targetSkill of targetSkills) {
      const normTarget = this.normalizeSkillName(targetSkill);
      let bestMatchVal = 0;
      let skillConf = 0;

      // 1. Check exact/normalized match
      if (normalizedCandidate.includes(normTarget)) {
        bestMatchVal = 1.0;
        skillConf = techConf.exactMatch;
      } else {
        // 2. Check ontology match with transferability
        const groupTarget = MatchingService.SKILL_INDEX[normTarget];
        if (groupTarget) {
          for (const candSkill of normalizedCandidate) {
            const groupCand = MatchingService.SKILL_INDEX[candSkill];
            if (groupCand) {
              if (groupTarget.family === groupCand.family && groupTarget.subfamily === groupCand.subfamily) {
                bestMatchVal = Math.max(bestMatchVal, 0.8);
                skillConf = Math.max(skillConf, techConf.subfamilyMatch);
              } else if (groupTarget.family === groupCand.family) {
                const tier = getTransferableFactor(groupTarget.subfamily, groupCand.subfamily);
                let tierFactor = config.transferability.factors.LOW;
                if (tier === 'HIGH') {
                  tierFactor = config.transferability.factors.HIGH;
                } else if (tier === 'MEDIUM') {
                  tierFactor = config.transferability.factors.MEDIUM;
                } else if (tier === 'LOW') {
                  tierFactor = config.transferability.factors.LOW;
                }
                bestMatchVal = Math.max(bestMatchVal, tierFactor);
                skillConf = Math.max(skillConf, techConf.familyMatch);
              }
            }
          }
        }
      }

      totalMatchValue += bestMatchVal;
      totalConfidenceValue += skillConf;

      if (bestMatchVal >= 0.7) {
        matched.push(targetSkill);
      } else {
        missing.push(targetSkill);
      }
    }

    const score = Math.round((totalMatchValue / targetSkills.length) * 100);
    const confidence = totalConfidenceValue / targetSkills.length;
    return { score, matched, missing, confidence };
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
    const logPrefix = `[DEBUG 2] Hard Filter | Job: "${jobTitle}" (${jobCompany}) |`;
    if (!this.config.matching.useHardFilters) {
      this.logger.log(`${logPrefix} PASSED (Hard Filters disabled)`);
      return true;
    }
    // 00. Empty / Insufficient Description Filter
    if (!jobDescription || jobDescription.trim().length < 150) {
      this.logger.log(`${logPrefix} FAILED (Description too short: ${jobDescription?.trim().length ?? 0} chars)`);
      return false;
    }

    // 0. Title Family & Subfamily Mismatch Filters
    const candFamily = detectFamily(profile.preferredRoles[0] || '');
    const jobFamily = detectFamily(jobTitle);
    if (candFamily && jobFamily && candFamily !== 'software' && jobFamily !== 'software' && candFamily !== jobFamily) {
      this.stats.titleReject++;
      this.logger.log(`${logPrefix} FAILED (Title family mismatch. Candidate family: ${candFamily}, Job family: ${jobFamily})`);
      return false;
    }

    const candSubfamily = detectSubfamily(profile.preferredRoles[0] || '');
    const jobSubfamily = detectSubfamily(jobTitle);
    if (candSubfamily && jobSubfamily && candSubfamily !== jobSubfamily) {
      this.stats.titleReject++;
      this.logger.log(`${logPrefix} FAILED (Title subfamily mismatch. Candidate subfamily: ${candSubfamily}, Job subfamily: ${jobSubfamily})`);
      return false;
    }

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
      this.logger.log(`${logPrefix} FAILED (Experience check. Candidate: ${candidateYears} yrs, Required Range: ${minYearsRequired}-${maxYearsRequired} yrs)`);
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
      this.logger.log(`${logPrefix} FAILED (Remote check. Candidate Remote Open: ${isCandidateOpenToRemote}, Job Remote: ${isJobRemote})`);
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
      this.logger.log(`${logPrefix} FAILED (Location check. Candidate Locs: [${candidateLocations.join(', ')}], Job Loc: "${reqs.location}", Candidate Remote Open: ${isCandidateOpenToRemote}, Job Remote: ${isJobRemote})`);
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
      this.logger.log(`${logPrefix} FAILED (Employment check. Candidate Prefs: [${profile.preferences.employmentTypes?.join(', ')}], Job Type: "${reqs.employmentType}")`);
      return false;
    }

    this.logger.log(`${logPrefix} PASSED. Exp: Candidate ${candidateYears} yrs vs Job Req: ${minYearsRequired} yrs; Loc check: Passed; Remote check: Passed; Emp check: Passed`);
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
        education: pref.education || [],
        projects: pref.projects || [],
        achievements: pref.achievements || [],
        preferredRoles: pref.preferred_roles,
        preferences: {
          locations: pref.locations,
          remote: pref.remote,
          employmentTypes: pref.employment_types,
        },
      };
    } catch (err: any) {
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
    } catch (err: any) {
      this.logger.error(`[MATCHING] Qdrant Error loading ingested jobs: ${err.message}`);
    }
    return list;
  }
}
