import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../vector-store/database.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { QdrantService } from '../vector-store/qdrant.service';
import { Job } from '../discovery/discovery.service';
import { ChatGroq } from '@langchain/groq';
import { PromptTemplate } from '@langchain/core/prompts';
import { StructuredOutputParser } from '@langchain/core/output_parsers';

export interface JobRequirements {
  requiredSkills: string[];
  preferredSkills: string[];
  experienceRequired: number;
  educationRequirements: string[];
  employmentType: string;
  remoteAllowed: boolean;
  location: string;
}

@Injectable()
export class JobIntelligenceService {
  private readonly logger = new Logger(JobIntelligenceService.name);
  private model: ChatGroq;

  constructor(
    private readonly db: DatabaseService,
    private readonly embeddingsService: EmbeddingsService,
    private readonly qdrantService: QdrantService,
  ) {
    this.model = new ChatGroq({
      apiKey: process.env.GROQ_API_KEY,
      model: 'llama-3.3-70b-versatile',
      temperature: 0,
    });
  }

  private async invokeOllama(promptText: string): Promise<string> {
    const ollamaUrl = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
    const ollamaModel = process.env.OLLAMA_MODEL || 'llama3';
    
    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        prompt: promptText,
        stream: false,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Ollama failed with status ${response.status}: ${errText}`);
    }

    const data = await response.json();
    return data.response;
  }

  private async invokeModelWithFallback(promptText: string): Promise<string> {
    const useOllama = process.env.USE_OLLAMA === 'true';

    if (useOllama) {
      try {
        return await this.invokeOllama(promptText);
      } catch (err) {
        this.logger.warn(`[JOB-INTEL: LLM] Local Ollama failed: ${err.message}. Falling back to standard API...`);
      }
    }

    const response = await this.model.invoke(promptText);
    return response.content as string;
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

  /**
   * Processes a job posting: Extracts metadata, generates embedding, and stores in database.
   * If job already exists, returns cached data.
   */
  async processJob(job: Job): Promise<JobRequirements> {
    const existingReq = await this.getCachedRequirements(job.jobId);
    if (existingReq) {
      this.logger.log(`[JOB-INTEL] Cache hit. Skipping extraction for job ID: ${job.jobId}`);
      return existingReq;
    }

    this.logger.log(`[JOB-INTEL] Extracting structured requirements for "${job.title}" at "${job.company}"...`);

    const prompt = `You are an elite talent acquisition AI. Extract the job requirements and structured metadata from the following job details.

Job Details:
- Title: ${job.title}
- Company: ${job.company}
- Location (From Scraper): ${job.location}
- Description/Snippet: ${job.description.substring(0, 25000)}

You MUST respond ONLY with a valid JSON object matching the following structure:
{
  "requiredSkills": ["skill1", "skill2"],
  "preferredSkills": ["skill3"],
  "experienceRequired": 2,
  "educationRequirements": ["degree1"],
  "employmentType": "Full-time",
  "remoteAllowed": true,
  "location": null
}

If any field (such as requiredSkills, experienceRequired, or location) cannot be determined from the description snippet, you MUST set them to [] (empty array), 0, or null respectively. Do not hallucinate or use the example values.
Do not include any conversational filler, explanation, or markdown formatting (such as \`\`\`json). Return only the raw JSON object.`;

    try {
      const responseText = await this.invokeModelWithFallback(prompt);
      const cleaned = this.cleanJsonText(responseText);
      
      let parsed: any;
      try {
        parsed = JSON.parse(cleaned);
      } catch (err) {
        this.logger.error(`JSON Parse error for job ${job.jobId}. Raw: "${cleaned}"`);
        throw err;
      }

      const parseArray = (val: any): string[] => {
        if (Array.isArray(val)) return val.map(v => String(v).trim()).filter(Boolean);
        if (typeof val === 'string') return val.split(',').map(s => s.trim()).filter(Boolean);
        return [];
      };

      const reqs: JobRequirements = {
        requiredSkills: parseArray(parsed.requiredSkills),
        preferredSkills: parseArray(parsed.preferredSkills),
        experienceRequired: parseFloat(parsed.experienceRequired) || 0,
        educationRequirements: parseArray(parsed.educationRequirements),
        employmentType: String(parsed.employmentType || 'Full-time').trim(),
        remoteAllowed: typeof parsed.remoteAllowed === 'boolean' ? parsed.remoteAllowed : String(parsed.remoteAllowed).toLowerCase() === 'true',
        location: (() => {
          const llmLoc = parsed.location && String(parsed.location).trim();
          if (llmLoc && llmLoc.toLowerCase() !== 'null' && llmLoc.toLowerCase() !== 'unknown' && llmLoc.toLowerCase() !== 'remote') {
            return llmLoc;
          }
          const rawLoc = (job.location || '').trim();
          const isQuery = rawLoc.includes(' OR ') || rawLoc.includes('(') || rawLoc.includes(')');
          if (isQuery) {
            return llmLoc ? llmLoc : 'Remote';
          }
          return rawLoc ? rawLoc : (llmLoc ? llmLoc : 'Remote');
        })(),
      };

      // Generate job description embedding
      const textToEmbed = `Job Title: ${job.title}\nCompany: ${job.company}\nLocation: ${reqs.location}\nRequired Skills: ${reqs.requiredSkills.join(', ')}\nDescription: ${job.description}`;
      this.logger.log(`[JOB-INTEL] Generating Job Embedding for ID: ${job.jobId}`);
      const embedding = await this.embeddingsService.generateEmbedding(textToEmbed);

      // Save to database
      await this.saveJobToDb(job, reqs, embedding);

      return reqs;
    } catch (err) {
      this.logger.error(`[JOB-INTEL] Failed to extract requirements for job ${job.jobId}: ${err.message}`, err.stack);
      
      // Fallback defaults to prevent pipeline crash
      const fallbackReqs: JobRequirements = {
        requiredSkills: [],
        preferredSkills: [],
        experienceRequired: 0,
        educationRequirements: [],
        employmentType: 'Full-time',
        remoteAllowed: /remote|hybrid/i.test(job.location + job.description),
        location: (() => {
          const rawLoc = (job.location || '').trim();
          const isQuery = rawLoc.includes(' OR ') || rawLoc.includes('(') || rawLoc.includes(')');
          return isQuery ? 'Remote' : (rawLoc || 'Remote');
        })(),
      };

      try {
        const textToEmbed = `Job Title: ${job.title}\nCompany: ${job.company}\nDescription: ${job.description}`;
        const embedding = await this.embeddingsService.generateEmbedding(textToEmbed);
        await this.saveJobToDb(job, fallbackReqs, embedding);
      } catch (saveErr) {
        this.logger.error(`[JOB-INTEL] Failed to save fallback job details to DB: ${saveErr.message}`);
      }

      return fallbackReqs;
    }
  }

  private async getCachedRequirements(jobId: string): Promise<JobRequirements | null> {
    try {
      const uuid = QdrantService.stringToUuid(jobId);
      const res = await this.qdrantService.getClient().retrieve('job_embeddings', {
        ids: [uuid],
        with_payload: true,
        with_vector: false,
      });

      if (res.length === 0) return null;
      const payload = res[0].payload as any;
      if (!payload) return null;

      return {
        requiredSkills: payload.requiredSkills || [],
        preferredSkills: payload.preferredSkills || [],
        experienceRequired: payload.experienceRequired || 0,
        educationRequirements: payload.educationRequirements || [],
        employmentType: payload.employmentType || 'Full-time',
        remoteAllowed: !!payload.remoteAllowed,
        location: payload.location || 'Remote',
      };
    } catch (err) {
      this.logger.error(`[JOB-INTEL] Qdrant error checking cached requirements: ${err.message}`);
      return null;
    }
  }

  private async saveJobToDb(job: Job, reqs: JobRequirements, embedding: number[]) {
    try {
      const uuid = QdrantService.stringToUuid(job.jobId);
      await this.qdrantService.getClient().upsert('job_embeddings', {
        wait: true,
        points: [
          {
            id: uuid,
            vector: embedding,
            payload: {
              jobId: job.jobId,
              title: job.title,
              company: job.company,
              url: job.applyUrl,
              description: job.description,
              location: reqs.location,
              postingDate: new Date().toISOString(),
              requiredSkills: reqs.requiredSkills,
              preferredSkills: reqs.preferredSkills,
              experienceRequired: reqs.experienceRequired,
              educationRequirements: reqs.educationRequirements,
              employmentType: reqs.employmentType,
              remoteAllowed: reqs.remoteAllowed,
            }
          }
        ]
      });
      this.logger.log(`[JOB-INTEL] Job ${job.jobId} and embedding successfully stored in Qdrant.`);
    } catch (err) {
      this.logger.error(`[JOB-INTEL] Failed to save job details to Qdrant: ${err.message}`);
      throw err;
    }
  }
}
