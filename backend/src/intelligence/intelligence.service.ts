import { Injectable, Logger } from '@nestjs/common';
import { ChatGroq } from '@langchain/groq';
import { PromptTemplate } from '@langchain/core/prompts';
import { StructuredOutputParser } from '@langchain/core/output_parsers';
import { Job } from '../discovery/discovery.service';
import { ProfileParser, UserProfile } from '../agent/profile.parser';
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
  private model: ChatGroq;
  private userProfile: UserProfile;

  constructor() {
    this.model = new ChatGroq({
      apiKey: process.env.GROQ_API_KEY,
      model: 'llama-3.3-70b-versatile',
      temperature: 0,
    });
    this.loadProfile();
  }

  private loadProfile() {
    try {
      const profilePath = path.join(process.cwd(), '..', 'profile.txt');
      this.userProfile = ProfileParser.parse(profilePath);
      this.logger.log(`[SCORER] Loaded user profile. Target Role: "${this.userProfile.targetRole}", Skills count: ${this.userProfile.coreSkills.length}, Target Location: "${this.userProfile.targetLocation}"`);
    } catch (e) {
      this.logger.error('[SCORER] Could not load profile.txt. Using defaults.', e);
      this.userProfile = {
        targetRole: 'Backend Software Engineer',
        coreSkills: ['Node.js', 'TypeScript', 'FastAPI', 'Python'],
        experienceLevel: 'Junior',
        preferences: 'Remote',
        targetLocation: 'Remote',
        isRemoteOpen: true,
      };
    }
  }

  async scoreJob(job: Job): Promise<JobScore> {
    this.logger.log(`[SCORER] Evaluating job: "${job.title}" at "${job.company}" (${job.location})`);
    
    // Reload profile on every evaluation to pick up local profile.txt edits in real time
    this.loadProfile();

    const parser = StructuredOutputParser.fromNamesAndDescriptions({
      isFakeOrSpam: 'boolean, true if the job looks like a scam, unpaid internship, or spam/suspicious posting',
      skillsScore: 'number from 0 to 100 representing how well the job requirements match the user core skills list',
      experienceScore: 'number from 0 to 100 representing how well the job requirements match the user experience level',
      locationScore: 'number from 0 to 100 representing how well the job location matches the user preferences',
      reasoning: 'string, 1-2 sentences explaining why the score was given',
      actualCompany: 'string, the actual hiring company name extracted from the job details (e.g. if company field is "Y Combinator startups in Noida" and snippet mentions Clinikally, the actualCompany is "Clinikally")',
      actualLocation: 'string, the actual location/city or remote status of the job extracted from the job details (e.g. "Noida", "Ahmedabad", "Remote", "Delhi")',
    });

    const formatInstructions = parser.getFormatInstructions();

    const prompt = PromptTemplate.fromTemplate(`
      You are an elite career agent. Evaluate this job posting against the user's profile.
      
      User Profile:
      - Target Role: {targetRole}
      - Core Skills: {coreSkills}
      - Experience Level: {experienceLevel}
      - Preferences/Target Location: {preferences} (Current target search city: {targetLocation})

      Job Posting:
      - Title: {title}
      - Company: {company}
      - Location (Scraper Placeholder): {location}
      - Description/Snippet: {snippet}

      CRITICAL LOCATION AND COMPANY EXTRACTION INSTRUCTIONS:
      1. The Location (Scraper Placeholder) "{location}" may be a search placeholder. You MUST inspect the Title ("{title}"), Company ("{company}"), and Description/Snippet ("{snippet}") to identify the actual/true location where the job is physically located (e.g., "Noida", "Ahmedabad", "Remote", "New York").
      2. If the company is "Y Combinator startups in Noida" or similar, extract the actual company name hiring for the role if mentioned (e.g. "Clinikally") as "actualCompany", and extract the actual location as "actualLocation" (e.g. "Noida").
      3. Rate the "locationScore" based on how well this "actualLocation" matches the user's target location ({targetLocation}) and work preferences ({preferences}). 
         - If the actualLocation is Noida, Bengaluru, Delhi, etc., and the user wants Onsite/Hybrid in Ahmedabad, the locationScore MUST be very low (0-20).
         - If the job is remote and the user allows remote, or if it matches the target city ({targetLocation}), rate it highly (80-100).

      Please analyze the job posting and assign sub-scores from 0 to 100 for each of the following:
      1. skillsScore: How well the job's technical stack matches the user's core skills ({coreSkills}).
      2. experienceScore: How well the job's seniority level matches the user's experience level ({experienceLevel}).
      3. locationScore: How well the true job location (actualLocation) matches the user's target location ({targetLocation}) and work preferences.

      {format_instructions}
    `);

    try {
      const formattedPrompt = await prompt.format({
        targetRole: this.userProfile.targetRole,
        coreSkills: this.userProfile.coreSkills.join(', '),
        experienceLevel: this.userProfile.experienceLevel,
        preferences: this.userProfile.preferences,
        targetLocation: this.userProfile.targetLocation,
        title: job.title,
        company: job.company,
        location: job.location,
        snippet: job.description,
        format_instructions: formatInstructions,
      });

      const response = await this.model.invoke(formattedPrompt);
      const parsedResult = await parser.parse(response.content as string);
      
      const skillsScore = parseInt(String(parsedResult.skillsScore), 10) || 0;
      const experienceScore = parseInt(String(parsedResult.experienceScore), 10) || 0;
      const locationScore = parseInt(String(parsedResult.locationScore), 10) || 0;
      const isFakeOrSpam = String(parsedResult.isFakeOrSpam).toLowerCase() === 'true';
      const reasoning = String(parsedResult.reasoning);
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
