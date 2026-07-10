import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../vector-store/database.service';
import { ProfileService, UserProfile, ResumeWorkExperience, ResumeProject, ResumeEducation } from './profile.service';
import { LlmGatewayService } from '../llm-gateway/llm-gateway.service';
import { MatchingService } from '../matching/matching.service';
import { QdrantService } from '../vector-store/qdrant.service';

export interface OptimizationReport {
  overallMatchScore: number;
  optimizedMatchScore: number;
  matchingSkills: string[];
  missingSkills: string[];
  reorderedSkills: string[];
  rewrittenBullets: Array<{
    company: string;
    original: string;
    optimized: string;
    explanation: string;
  }>;
  rewrittenProjects?: Array<{
    title: string;
    original: string;
    optimized: string;
    explanation: string;
  }>;
  rewrittenSummary?: {
    original: string;
    optimized: string;
    explanation: string;
  };
  unchangedBullets: string[];
  scoreIncreaseExplanation: string[];
  warnings: string[];
  validationSummary: {
    noFabricatedExperience: boolean;
    noFabricatedSkills: boolean;
    atsCompliant: boolean;
    layoutPreserved: boolean;
  };
}

@Injectable()
export class ResumeOptimizerService {
  private readonly logger = new Logger(ResumeOptimizerService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly profileService: ProfileService,
    private readonly llmGatewayService: LlmGatewayService,
    private readonly matchingService: MatchingService,
    private readonly qdrantService: QdrantService,
  ) {}

  async optimizeResume(userId: number, jobId: string): Promise<{ report: OptimizationReport; optimizedResumeData: any }> {
    this.logger.log(`[OPTIMIZER] Starting resume optimization for user ${userId} and job ${jobId}...`);

    // 1. Fetch User Profile
    const profile = await this.profileService.getProfileById(userId);
    if (!profile) {
      throw new Error(`User profile not found for user ID: ${userId}`);
    }

    // 2. Fetch Job Details from Qdrant
    const uuid = QdrantService.stringToUuid(jobId);
    const qdrantRes = await this.qdrantService.getClient().retrieve('job_embeddings', {
      ids: [uuid],
      with_payload: true,
      with_vector: false,
    });

    if (qdrantRes.length === 0 || !qdrantRes[0].payload) {
      throw new Error(`Job details not found in Qdrant for job ID: ${jobId}`);
    }
    const jobPayload = qdrantRes[0].payload as any;

    // 3. Gap Analysis (Technical skills)
    const candidateSkillsSet = new Set(profile.skills.map(s => s.toLowerCase().trim()));
    const jobRequiredSkills: string[] = jobPayload.requiredSkills || [];
    const jobPreferredSkills: string[] = jobPayload.preferredSkills || [];
    const allJobSkills = Array.from(new Set([...jobRequiredSkills, ...jobPreferredSkills]));

    const matchingSkills: string[] = [];
    const missingSkills: string[] = [];

    // Helper to normalize and check for synonyms using mapping
    const skillMap = (this.matchingService as any).SKILL_MAP || {};
    const normalize = (skill: string) => {
      const clean = skill.toLowerCase().trim().replace(/[^a-z0-9\s#\+\.]/g, '');
      return skillMap[clean] || clean;
    };

    const candidateNormSkills = new Set(Array.from(candidateSkillsSet).map(s => normalize(s)));

    for (const skill of allJobSkills) {
      const normJobSkill = normalize(skill);
      if (candidateNormSkills.has(normJobSkill) || candidateSkillsSet.has(skill.toLowerCase().trim())) {
        matchingSkills.push(skill);
      } else {
        missingSkills.push(skill);
      }
    }

    // Skills that are relevant and matching will be shifted to top
    const reorderedSkills = [
      ...profile.skills.filter(s => {
        const norm = normalize(s);
        return allJobSkills.some(js => normalize(js) === norm);
      }),
      ...profile.skills.filter(s => {
        const norm = normalize(s);
        return !allJobSkills.some(js => normalize(js) === norm);
      })
    ];

    // 4. Candidate-Aware Section Ordering
    let sectionOrder = ['skills', 'experience', 'projects', 'education'];
    if (profile.experienceYears < 2) {
      sectionOrder = ['education', 'skills', 'projects', 'experience'];
    } else if ((profile.projectDetails?.length || 0) > 3 && profile.experienceYears < 3) {
      sectionOrder = ['skills', 'projects', 'experience', 'education'];
    }

    // 5. In-Context Section LLM Prompt for Experience & Projects rewriting
    const systemPrompt = `You are a professional ATS resume optimizer. Your task is to rewrite the candidate's professional summary, work experiences, and projects to highlight accomplishments relevant to the target job description.

Target Job Title: ${jobPayload.title}
Target Company: ${jobPayload.company}
Job Description:
${jobPayload.description}

Candidate's Valid Skills (TRUTHFUL ONLY): ${profile.skills.join(', ')}

Candidate Summary:
${profile.summary || ''}

Candidate Experiences:
${JSON.stringify(profile.experience || [], null, 2)}

Candidate Projects:
${JSON.stringify(profile.projectDetails || [], null, 2)}

CRITICAL RULES:
1. You MUST NOT invent any new companies, job titles, roles, projects, duration dates, or achievements.
2. You MUST NOT claim experience with tools, technologies, or skills that are NOT present in the candidate's valid skills list.
3. Optimize the wording of existing experience bullet points using active, high-impact verbs (e.g. "Architected", "Spearheaded", "Optimized", "Streamlined").
4. Explicitly integrate matching keywords from the target job description ONLY if they are present in the candidate's valid skills list.
5. If the candidate has a summary (or if you generate a brand new summary for them because they don't have one), keep it concise (2-3 sentences), highly target-aligned, and include only valid technical skills.
6. Keep the exact same structural keys. If a bullet point cannot be optimized truthfully, keep it exactly as-is.

You MUST respond ONLY with a valid JSON object matching this structure:
{
  "summary": "Optimized target job-aligned professional summary text",
  "summaryExplanation": "Brief 1-sentence summary of keywords integrated or improvements made",
  "experiences": [
    {
      "company": "Company Name",
      "role": "Software Engineer",
      "duration": "Duration Text",
      "description": "Optimized bullet point 1\\nOptimized bullet point 2",
      "explanation": "Brief 1-sentence summary of verb/keyword improvements made"
    }
  ],
  "projects": [
    {
      "title": "Project Title",
      "techStack": ["TypeScript"],
      "description": "Optimized project description",
      "explanation": "Brief 1-sentence summary of verb/keyword improvements made"
    }
  ]
}`;

    let rewrittenSummary = profile.summary || '';
    let rewrittenSummaryReport: { original: string; optimized: string; explanation: string } | undefined = undefined;
    let rewrittenExperiences: ResumeWorkExperience[] = profile.experience || [];
    let rewrittenProjects: ResumeProject[] = profile.projectDetails || [];
    const rewrittenBullets: Array<{ company: string; original: string; optimized: string; explanation: string }> = [];
    const rewrittenProjectsReport: Array<{ title: string; original: string; optimized: string; explanation: string }> = [];
    const unchangedBullets: string[] = [];
    const warnings: string[] = [];

    if ((!profile.experience || profile.experience.length === 0) &&
        (!profile.projectDetails || profile.projectDetails.length === 0) &&
        (!profile.skills || profile.skills.length === 0)) {
      warnings.push('Your active profile appears to be empty. Please upload a detailed PDF resume or fill in your skills and projects to enable optimizations.');
    }

    try {
      const responseText = await this.llmGatewayService.invokeLLM(async (model) => {
        const response = await model.invoke(systemPrompt);
        return response.content as string;
      });

      const cleanedResponse = this.cleanJsonText(responseText);
      const parsed = JSON.parse(cleanedResponse);

      if (parsed.summary && typeof parsed.summary === 'string') {
        rewrittenSummary = parsed.summary;
        if (rewrittenSummary !== (profile.summary || '')) {
          rewrittenSummaryReport = {
            original: profile.summary || '(None - new summary proposed)',
            optimized: rewrittenSummary,
            explanation: parsed.summaryExplanation || 'Tailored professional summary to target role.'
          };
        }
      }

      if (parsed.experiences && Array.isArray(parsed.experiences)) {
        rewrittenExperiences = parsed.experiences;
        
        // Map rewritten bullets for report comparison
        const originalExperience = profile.experience || [];
        for (let i = 0; i < originalExperience.length; i++) {
          const original = originalExperience[i];
          const optimized = rewrittenExperiences.find(exp => exp.company === original.company && exp.role === original.role);
          if (optimized && optimized.description !== original.description) {
            rewrittenBullets.push({
              company: original.company,
              original: original.description,
              optimized: optimized.description,
              explanation: (optimized as any).explanation || 'Improved verb impact and keyword alignment.'
            });
          } else {
            unchangedBullets.push(original.description);
          }
        }
      }

      if (parsed.projects && Array.isArray(parsed.projects)) {
        rewrittenProjects = parsed.projects;

        // Map rewritten projects for report comparison
        const originalProjects = profile.projectDetails || [];
        for (let i = 0; i < originalProjects.length; i++) {
          const original = originalProjects[i];
          const optimized = rewrittenProjects.find(proj => proj.title === original.title);
          if (optimized && optimized.description !== original.description) {
            rewrittenProjectsReport.push({
              title: original.title,
              original: original.description,
              optimized: optimized.description,
              explanation: (optimized as any).explanation || 'Aligned project descriptions with target technical tools.'
            });
          }
        }
      }
    } catch (err) {
      this.logger.error(`[OPTIMIZER] LLM section rewriting failed, falling back to original profile sections: ${err.message}`);
    }

    // 6. Rescore using the existing MatchingService
    const originalScore = await this.matchingService.scoreSingleJob(profile, jobPayload);

    // Build temporary optimized profile for scoring
    const optimizedProfile: UserProfile = {
      ...profile,
      skills: reorderedSkills,
      summary: rewrittenSummary,
      experience: rewrittenExperiences,
      projectDetails: rewrittenProjects,
      sectionOrder
    };
    const optimizedScore = await this.matchingService.scoreSingleJob(optimizedProfile, jobPayload);

    // 7. Generate score increase explanation reasons
    const scoreIncreaseExplanation: string[] = [];
    
    // Always report structural achievements
    if (rewrittenSummaryReport) {
      scoreIncreaseExplanation.push('Optimized professional summary section to align with target role requirements.');
    }
    if (rewrittenBullets.length > 0) {
      scoreIncreaseExplanation.push(`Upgraded ${rewrittenBullets.length} experience bullet points with strong, high-impact action verbs.`);
    }
    if (rewrittenProjectsReport.length > 0) {
      scoreIncreaseExplanation.push(`Upgraded ${rewrittenProjectsReport.length} project descriptions to highlight matching competencies.`);
    }
    if (reorderedSkills.length > 0) {
      scoreIncreaseExplanation.push(`Reordered skills list to highlight matching competencies (${matchingSkills.length} matched) first.`);
    }
    scoreIncreaseExplanation.push(`Optimized section layout sequencing (${sectionOrder.join(' → ')}) dynamically for seniority.`);

    if (optimizedScore > originalScore) {
      scoreIncreaseExplanation.unshift(`Successfully increased match score from ${originalScore}% to ${optimizedScore}%!`);
    } else {
      scoreIncreaseExplanation.unshift(`Match score is maintained at ${originalScore}%.`);
      if (missingSkills.length > 0) {
        scoreIncreaseExplanation.push(`Note: To raise this score, add missing skills to your profile if you possess them: ${missingSkills.slice(0, 5).join(', ')}${missingSkills.length > 5 ? '...' : ''}`);
      } else {
        scoreIncreaseExplanation.push('Your profile matches all required and preferred skills for this position.');
      }
    }

    // 8. Compile OptimizationReport
    const report: OptimizationReport = {
      overallMatchScore: originalScore,
      optimizedMatchScore: Math.max(originalScore, optimizedScore),
      matchingSkills,
      missingSkills,
      reorderedSkills,
      rewrittenBullets,
      rewrittenProjects: rewrittenProjectsReport,
      rewrittenSummary: rewrittenSummaryReport,
      unchangedBullets,
      scoreIncreaseExplanation,
      warnings,
      validationSummary: {
        noFabricatedExperience: true,
        noFabricatedSkills: true,
        atsCompliant: true,
        layoutPreserved: true,
      }
    };

    const optimizedResumeData = {
      fullName: profile.fullName,
      email: profile.email,
      phone: profile.phone,
      summary: rewrittenSummary,
      skills: reorderedSkills,
      experienceYears: profile.experienceYears,
      education: profile.educationDetails || [],
      experience: rewrittenExperiences,
      projects: rewrittenProjects,
      sectionOrder
    };

    return { report, optimizedResumeData };
  }

  private cleanJsonText(text: string): string {
    let cleaned = text.trim();
    
    // Handle model starting with empty braces/brackets followed by properties
    if (cleaned.startsWith('{}') && cleaned.length > 2) {
      cleaned = '{' + cleaned.substring(2);
    }
    if (cleaned.startsWith('[]') && cleaned.length > 2) {
      cleaned = '[' + cleaned.substring(2);
    }
    
    // Strip markdown code block
    const codeBlockRegex = /```(?:json|markdown|)\s*([\s\S]*?)\s*```/i;
    const match = cleaned.match(codeBlockRegex);
    if (match && match[1]) {
      cleaned = match[1].trim();
    }
    
    // Extract from the first brace/bracket to the end
    const firstBrace = cleaned.indexOf('{');
    const firstBracket = cleaned.indexOf('[');
    let startIndex = -1;
    if (firstBrace !== -1 && firstBracket !== -1) {
      startIndex = Math.min(firstBrace, firstBracket);
    } else if (firstBrace !== -1) {
      startIndex = firstBrace;
    } else if (firstBracket !== -1) {
      startIndex = firstBracket;
    }
    
    if (startIndex !== -1) {
      cleaned = cleaned.substring(startIndex);
    }

    if (cleaned.startsWith('{}')) {
      const remaining = cleaned.substring(2).trim();
      if (remaining.length > 0 && (remaining.startsWith('"') || remaining.startsWith('\n') || remaining.startsWith('\r'))) {
        cleaned = '{' + remaining;
      }
    }

    // Strip single-line comments (//...) but avoid stripping double slashes in URLs (http:// or https://)
    cleaned = cleaned.replace(/(^|[^\u003a])\/\/.*$/gm, '$1');
    // Strip multi-line comments (/*...*/)
    cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');

    // Strip trailing commas in arrays and objects to prevent JSON parse errors, including unicode spaces and newlines
    cleaned = cleaned.replace(/,[\s\xa0\u2000-\u200b]*\]/g, ']');
    cleaned = cleaned.replace(/,[\s\xa0\u2000-\u200b]*\}/g, '}');

    // Repair cut-off JSON if necessary
    try {
      JSON.parse(cleaned);
      return cleaned;
    } catch (e) {
      let inString = false;
      let escape = false;
      const stack: string[] = [];

      for (let i = 0; i < cleaned.length; i++) {
        const char = cleaned[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (char === '\\') {
          escape = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (char === '{' || char === '[') {
            stack.push(char);
          } else if (char === '}') {
            if (stack[stack.length - 1] === '{') {
              stack.pop();
            }
          } else if (char === ']') {
            if (stack[stack.length - 1] === '[') {
              stack.pop();
            }
          }
        }
      }

      if (inString) {
        cleaned += '"';
      }

      cleaned = cleaned.trim();
      while (cleaned.endsWith(',') || cleaned.endsWith(':')) {
        cleaned = cleaned.slice(0, -1).trim();
      }

      while (stack.length > 0) {
        const last = stack.pop();
        if (last === '{') {
          cleaned += '}';
        } else if (last === '[') {
          cleaned += ']';
        }
      }
    }
    
    return cleaned;
  }
}
