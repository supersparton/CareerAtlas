import { Injectable, Logger } from '@nestjs/common';
import { PromptTemplate } from '@langchain/core/prompts';
import { StructuredOutputParser } from '@langchain/core/output_parsers';
import { LlmGatewayService } from '../llm-gateway/llm-gateway.service';
import { Job } from '../discovery/discovery.service';
import { ParsedProfile as UserProfile } from '../profile/profile.service';
import * as path from 'path';

export interface JobScore {
  isFakeOrSpam: boolean;
  skillsScore: number;
  experienceScore: number;
  locationScore: number;
  reasoning: string;
  finalScore: number;
  actualCompany?: string;
  actualLocation?: string;
}

@Injectable()
export class IntelligenceService {
  private readonly logger = new Logger(IntelligenceService.name);

  constructor(
    private readonly llmGatewayService: LlmGatewayService,
  ) {}

  private async invokeModelWithFallback(promptText: string): Promise<string> {
    try {
      return await this.llmGatewayService.invokeLLM(async (model) => {
        const response = await model.invoke(promptText);
        return response.content as string;
      });
    } catch (err) {
      this.logger.error(`[LLM: SCORER] All LLM providers/keys failed: ${err.message}`);
      throw err;
    }
  }

  private cleanJsonText(text: string): string {
    let cleaned = text.trim();
    
    // 1. Try to extract from markdown code blocks
    const codeBlockRegex = /```(?:json|markdown|)\s*([\s\S]*?)\s*```/i;
    const match = cleaned.match(codeBlockRegex);
    if (match && match[1]) {
      cleaned = match[1].trim();
    }
    
    // 2. If it still doesn't look like raw JSON starts with '{' or '[', find first and last brace
    if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        cleaned = cleaned.substring(firstBrace, lastBrace + 1);
      }
    }
    
    return cleaned;
  }


  async scoreJob(job: Job, userProfile: UserProfile, activeSearchLocation?: string): Promise<JobScore> {
    this.logger.log(`[SCORER] Evaluating job: "${job.title}" at "${job.company}" (${job.location})`);
    
    const parser = StructuredOutputParser.fromNamesAndDescriptions({
      isFakeOrSpam: 'boolean, true if the job looks like a scam, unpaid internship, or spam/suspicious posting',
      skillsScore: 'number from 0 to 100 representing how well the job requirements match the user core skills list',
      experienceScore: 'number from 0 to 100 representing how well the job requirements match the user experience level',
      locationScore: 'number from 0 to 100 representing how well the job location matches the user preferences and active search target',
      reasoning: 'string, 1-2 sentences explaining why the score was given',
      actualCompany: 'string, the actual hiring company name extracted from the job details',
      actualLocation: 'string, the actual location/city or remote status of the job extracted from the job details (e.g. "Noida", "Ahmedabad", "Remote", "Delhi")',
    });

    const formatInstructions = parser.getFormatInstructions();
    const activeLoc = activeSearchLocation || userProfile.targetLocation || 'Remote';

    const prompt = PromptTemplate.fromTemplate(`
      You are an elite career agent. Evaluate this job posting against the user's profile and current search parameters.
      
      User Profile & Search Config:
      - Target Role: {targetRole}
      - Core Skills: {coreSkills}
      - Experience Level: {experienceLevel}
      - Profile Preferences: {preferences}
      - Active Search Target Location: {activeLoc}
 
      Job Posting:
      - Title: {title}
      - Company: {company}
      - Location (Scraper Placeholder): {location}
      - Description/Snippet: {snippet}
 
      CRITICAL LOCATION AND COMPANY EXTRACTION INSTRUCTIONS:
      1. The Location (Scraper Placeholder) "{location}" may be a search placeholder. You MUST inspect the Title ("{title}"), Company ("{company}"), and Description/Snippet ("{snippet}") to identify the actual/true location where the job is physically located (e.g., "Noida", "Ahmedabad", "Remote", "Delhi").
      2. If the company is "Y Combinator startups in Noida" or similar, extract the actual company name hiring for the role if mentioned as "actualCompany", and extract the actual location as "actualLocation" (e.g. "Noida").
      3. Rate the "locationScore" based on how well this "actualLocation" matches the Active Search Target Location ({activeLoc}) and work preferences ({preferences}). 
         - If the job actualLocation matches the Active Search Target Location (or is a city listed in it, e.g. "Bangalore" matches "Bangalore OR Remote"), the locationScore MUST be high (80-100).
         - If the job is remote and the user allows remote, or if it matches the target city ({activeLoc}), rate it highly (80-100).
         - If the job is onsite/hybrid in a completely different city that was NOT part of the Active Search Target Location, rate it very low (0-20).
 
      CRITICAL EXPERIENCE SCORING INSTRUCTIONS:
      1. Carefully compare the years of experience or seniority level required by the job posting (found in Title or Description/Snippet) with the candidate's Experience Level ({experienceLevel}).
      2. If the candidate's Experience Level is "Junior (0-2 years)":
         - If the job Title or Description/Snippet explicitly requires 3+ years, 4+ years, 5+ years, 8+ years, or mentions terms like "Senior", "Lead", "Staff", "Principal", "Architect", or "Manager", the experienceScore MUST be very low (0 to 30). You MUST heavily penalize these senior/mid-senior roles.
         - If the job is explicitly for "Junior", "Entry Level", "Associate", "Graduate", or does not specify required experience years, the experienceScore should be high (80 to 100).
      3. If the candidate's Experience Level is "Mid-Level (3-5 years)":
         - If the job requires 3-5 years of experience, or mentions "Mid-Level", rate the experienceScore highly (80 to 100).
         - If the job requires 8+ years or is "Senior/Lead/Principal", rate it low (30 to 50).
 
      Please analyze the job posting and assign sub-scores from 0 to 100 for each of the following:
      1. skillsScore: How well the job's technical stack matches the user's core skills ({coreSkills}).
      2. experienceScore: How well the job's seniority level matches the user's experience level ({experienceLevel}) based on the rules above.
      3. locationScore: How well the true job location (actualLocation) matches the Active Search Target Location ({activeLoc}) and work preferences.
 
      {format_instructions}
    `);

    try {
      const formattedPrompt = await prompt.format({
        targetRole: userProfile.targetRole,
        coreSkills: userProfile.coreSkills.join(', '),
        experienceLevel: userProfile.experienceLevel,
        preferences: userProfile.preferences,
        activeLoc: activeLoc,
        title: job.title,
        company: job.company,
        location: job.location,
        snippet: job.description,
        format_instructions: formatInstructions,
      });

      const responseText = await this.invokeModelWithFallback(formattedPrompt);
      const cleanedResponse = this.cleanJsonText(responseText);
      
      let parsedResult: any;
      try {
        parsedResult = JSON.parse(cleanedResponse);
      } catch (err) {
        this.logger.warn(`[SCORER] Direct JSON.parse failed. Falling back to LangChain parser: ${err.message}`);
        parsedResult = await parser.parse(cleanedResponse);
      }
      
      const skillsScore = parseInt(String(parsedResult.skillsScore), 10) || 0;
      const experienceScore = parseInt(String(parsedResult.experienceScore), 10) || 0;
      const locationScore = parseInt(String(parsedResult.locationScore), 10) || 0;
      const isFakeOrSpam = typeof parsedResult.isFakeOrSpam === 'boolean' 
        ? parsedResult.isFakeOrSpam 
        : String(parsedResult.isFakeOrSpam).toLowerCase() === 'true';
      const reasoning = String(parsedResult.reasoning || '');
      const actualCompany = String(parsedResult.actualCompany || job.company);
      const actualLocation = String(parsedResult.actualLocation || job.location);

      // Weighted scoring calculation in code (0.5 * skills + 0.3 * exp + 0.2 * loc)
      const finalScore = Math.round(
        0.5 * skillsScore +
        0.3 * experienceScore +
        0.2 * locationScore
      );

      this.logger.log(`[SCORER] Evaluated "${actualCompany} - ${job.title}" | True Location="${actualLocation}" | Skill=${skillsScore} Exp=${experienceScore} Loc=${locationScore} | Final=${finalScore}`);

      return {
        isFakeOrSpam,
        skillsScore,
        experienceScore,
        locationScore,
        reasoning,
        finalScore,
        actualCompany,
        actualLocation,
      };
    } catch (e) {
      this.logger.error(`[SCORER] Failed to score job: ${e.message}`);
      return {
        isFakeOrSpam: false,
        skillsScore: 0,
        experienceScore: 0,
        locationScore: 0,
        reasoning: 'Error evaluating job details.',
        finalScore: 0,
        actualCompany: job.company,
        actualLocation: job.location,
      };
    }
  }
}
