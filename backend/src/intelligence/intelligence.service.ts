import { Injectable, Logger } from '@nestjs/common';
import { ChatGroq } from '@langchain/groq';
import { PromptTemplate } from '@langchain/core/prompts';
import { StructuredOutputParser } from '@langchain/core/output_parsers';
import * as fs from 'fs';
import * as path from 'path';

export interface JobScore {
  isFakeOrSpam: boolean;
  matchScore: number;
  reasoning: string;
}

@Injectable()
export class IntelligenceService {
  private readonly logger = new Logger(IntelligenceService.name);
  private model: ChatGroq;
  private userProfile: string;

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
      this.userProfile = fs.readFileSync(profilePath, 'utf-8');
      this.logger.log('Loaded user profile successfully.');
    } catch (e) {
      this.logger.error('Could not load profile.txt', e);
      this.userProfile = 'No profile provided.';
    }
  }

  async scoreJob(jobTitle: string, company: string, snippet: string): Promise<JobScore> {
    this.logger.log(`Evaluating job: ${jobTitle} at ${company}...`);

    const parser = StructuredOutputParser.fromNamesAndDescriptions({
      isFakeOrSpam: 'boolean, true if the job looks like a scam, unpaid, or suspicious',
      matchScore: 'number from 1 to 100 representing how well the job fits the user profile',
      reasoning: 'string, 1-2 sentences explaining why it is a good or bad fit based on skills',
    });

    const formatInstructions = parser.getFormatInstructions();

    const prompt = PromptTemplate.fromTemplate(`
      You are an elite career agent. Evaluate this job posting against the user's profile.
      
      User Profile:
      {profile}

      Job Posting:
      Title: {title}
      Company: {company}
      Snippet: {snippet}

      Is this a fake/spam job? Is it a good match for the user?
      
      {format_instructions}
    `);

    try {
      const formattedPrompt = await prompt.format({
        profile: this.userProfile,
        title: jobTitle,
        company: company,
        snippet: snippet,
        format_instructions: formatInstructions,
      });

      const response = await this.model.invoke(formattedPrompt);
      const parsedResult = await parser.parse(response.content as string);
      
      return {
        isFakeOrSpam: String(parsedResult.isFakeOrSpam).toLowerCase() === 'true',
        matchScore: parseInt(String(parsedResult.matchScore), 10) || 0,
        reasoning: String(parsedResult.reasoning),
      };
    } catch (e) {
      this.logger.error(`Failed to score job: ${e.message}`);
      return { isFakeOrSpam: false, matchScore: 0, reasoning: 'Error scoring job.' };
    }
  }
}
