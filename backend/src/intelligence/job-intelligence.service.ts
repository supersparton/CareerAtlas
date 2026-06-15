import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../vector-store/database.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { QdrantService } from '../vector-store/qdrant.service';
import { LlmGatewayService } from '../llm-gateway/llm-gateway.service';
import { Job } from '../discovery/discovery.service';
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

  constructor(
    private readonly db: DatabaseService,
    private readonly embeddingsService: EmbeddingsService,
    private readonly qdrantService: QdrantService,
    private readonly llmGatewayService: LlmGatewayService,
  ) {}

  private async invokeModelWithFallback(promptText: string): Promise<string> {
    try {
      return await this.llmGatewayService.invokeLLM(async (model) => {
        const response = await model.invoke(promptText);
        return response.content as string;
      });
    } catch (err) {
      this.logger.error(`[JOB-INTEL: LLM] All LLM providers/keys failed: ${err.message}`);
      throw err;
    }
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
   * Extracts job requirements and structured metadata from the description using LLM.
   * Checks cache (Qdrant) first.
   */
  async extractRequirements(job: Job): Promise<JobRequirements> {
    const existingReq = await this.getCachedRequirements(job.jobId);
    if (existingReq) {
      this.logger.log(`[JOB-INTEL] Cache hit. Skipping extraction for job ID: ${job.jobId}`);
      return existingReq;
    }

    // Try fetching full description from URL first if not already enriched by ScrapingWorker
    if (!job.description || job.description.length < 500) {
      const fullDescription = await this.fetchFullDescription(job.applyUrl);
      if (fullDescription) {
        job.description = fullDescription;
      }
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

      // Infer minimum required experience from title keywords as a fallback for short snippets
      let inferredYears = 0;
      const titleLower = job.title.toLowerCase();
      if (/\b(principal|staff|architect|director|vp|head|vice president)\b/i.test(titleLower)) {
        inferredYears = 8;
      } else if (/\b(lead|manager|engineering lead|tech lead)\b/i.test(titleLower)) {
        inferredYears = 6;
      } else if (/\b(senior|sr\b|sr\.|\biii\b|\biv\b|\bv\b)\b/i.test(titleLower)) {
        inferredYears = 5;
      }

      const reqs: JobRequirements = {
        requiredSkills: parseArray(parsed.requiredSkills),
        preferredSkills: parseArray(parsed.preferredSkills),
        experienceRequired: Math.max(parseFloat(parsed.experienceRequired) || 0, inferredYears),
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

      return reqs;
    } catch (err) {
      this.logger.error(`[JOB-INTEL] Failed to extract requirements for job ${job.jobId}: ${err.message}`, err.stack);
      
      // Infer minimum required experience from title keywords for the fallback block
      let inferredYears = 0;
      const titleLower = job.title.toLowerCase();
      if (/\b(principal|staff|architect|director|vp|head|vice president)\b/i.test(titleLower)) {
        inferredYears = 8;
      } else if (/\b(lead|manager|engineering lead|tech lead)\b/i.test(titleLower)) {
        inferredYears = 6;
      } else if (/\b(senior|sr\b|sr\.|\biii\b|\biv\b|\bv\b)\b/i.test(titleLower)) {
        inferredYears = 5;
      }

      // Fallback defaults to prevent pipeline crash
      const fallbackReqs: JobRequirements = {
        requiredSkills: [],
        preferredSkills: [],
        experienceRequired: inferredYears,
        educationRequirements: [],
        employmentType: 'Full-time',
        remoteAllowed: /remote|hybrid/i.test(job.location + job.description),
        location: (() => {
          const rawLoc = (job.location || '').trim();
          const isQuery = rawLoc.includes(' OR ') || rawLoc.includes('(') || rawLoc.includes(')');
          return isQuery ? 'Remote' : (rawLoc || 'Remote');
        })(),
      };

      return fallbackReqs;
    }
  }

  /**
   * Processes a job posting: Extracts metadata, generates embedding, and stores in database.
   * If job already exists, returns cached data.
   */
  async processJob(job: Job): Promise<JobRequirements> {
    const reqs = await this.extractRequirements(job);

    // Generate job description embedding
    try {
      const textToEmbed = `Job Title: ${job.title}\nCompany: ${job.company}\nLocation: ${reqs.location}\nRequired Skills: ${reqs.requiredSkills.join(', ')}\nDescription: ${job.description}`;
      this.logger.log(`[JOB-INTEL] Generating Job Embedding for ID: ${job.jobId}`);
      const embedding = await this.embeddingsService.generateEmbedding(textToEmbed);

      // Save to database
      await this.saveJobToDb(job, reqs, embedding);
    } catch (err) {
      this.logger.error(`[JOB-INTEL] Failed to generate/save embedding for job ${job.jobId}: ${err.message}`);
    }

    return reqs;
  }

  async getCachedRequirements(jobId: string): Promise<JobRequirements | null> {
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

  async saveJobToDb(job: Job, reqs: JobRequirements, embedding: number[]) {
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

  private async fetchFullDescription(url: string): Promise<string | null> {
    if (!url) return null;
    try {
      this.logger.log(`[JOB-INTEL] Fetching full job description page from: ${url}`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        this.logger.warn(`[JOB-INTEL] Direct fetch failed with status: ${response.status} for ${url}`);
        return null;
      }

      const html = await response.text();
      
      // Strip script and style tags completely
      let cleanText = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
      cleanText = cleanText.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
      
      // Try to target common job description elements for popular platforms to reduce noise
      let matchedText = '';
      
      // Lever
      if (url.includes('lever.co')) {
        const leverMatch = cleanText.match(/<div class="section-wrapper"[\s\S]*?<\/div>[\s\S]*?<\/div>/i)
                     || cleanText.match(/<div class="sectionpage page-full"[\s\S]*?<\/div>/i);
        if (leverMatch) matchedText = leverMatch[0];
      }
      // Greenhouse
      else if (url.includes('greenhouse.io')) {
        const ghMatch = cleanText.match(/<div id="content"[\s\S]*?<\/div>/i);
        if (ghMatch) matchedText = ghMatch[0];
      }
      // Ashby
      else if (url.includes('ashbyhq.com')) {
        const ashbyMatch = cleanText.match(/<div class="_description_[\s\S]*?<\/div>/i);
        if (ashbyMatch) matchedText = ashbyMatch[0];
      }
      // LinkedIn public job details
      else if (url.includes('linkedin.com')) {
        const liMatch = cleanText.match(/<div class="show-more-less-html__markup[\s\S]*?<\/div>/i)
                     || cleanText.match(/<section class="show-more-less-html"[\s\S]*?<\/section>/i)
                     || cleanText.match(/<div class="description__text[\s\S]*?<\/div>/i);
        if (liMatch) matchedText = liMatch[0];
      }

      if (!matchedText) {
        // Fallback: Use body content if no specific container matches
        const bodyMatch = cleanText.match(/<body[\s\S]*?<\/body>/i);
        matchedText = bodyMatch ? bodyMatch[0] : cleanText;
      }

      // Strip all HTML tags
      cleanText = matchedText.replace(/<[^>]*>/g, ' ');
      
      // Clean up whitespace
      cleanText = cleanText.replace(/\s+/g, ' ').trim();
      
      if (cleanText.length > 200) {
        this.logger.log(`[JOB-INTEL] Successfully fetched and parsed ${cleanText.length} characters of description text.`);
        return cleanText;
      }

      return null;
    } catch (err: any) {
      this.logger.warn(`[JOB-INTEL] Failed to scrape job description: ${err.message}`);
      return null;
    }
  }
}
