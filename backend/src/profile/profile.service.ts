import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../vector-store/database.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { QdrantService } from '../vector-store/qdrant.service';
import { LlmGatewayService } from '../llm-gateway/llm-gateway.service';
import { PromptTemplate } from '@langchain/core/prompts';
import pdfParse from 'pdf-parse';
import { Subject, Observable } from 'rxjs';

export interface UserProfile {
  id?: number;
  fullName: string;
  email: string;
  phone?: string;
  skills: string[];
  experienceYears: number;
  education: string[];
  projects: string[];
  achievements: string[];
  preferredRoles: string[];
  preferences: {
    locations: string[];
    remote: boolean;
    employmentTypes: string[];
    salaryExpectation?: number;
  };
}

export interface ParsedProfile {
  fullName: string;
  email: string;
  phone: string;
  education: string[];
  targetRole: string;
  coreSkills: string[];
  experienceLevel: string;
  preferences: string;
}

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);
  private readonly taskEvents = new Subject<{ taskId: string; status: 'running' | 'success' | 'error'; log: string; errorDetails?: string; profile?: UserProfile }>();

  constructor(
    private readonly db: DatabaseService,
    private readonly embeddingsService: EmbeddingsService,
    private readonly qdrantService: QdrantService,
    private readonly llmGatewayService: LlmGatewayService,
  ) {}

  emitTaskEvent(taskId: string | undefined, status: 'running' | 'success' | 'error', log: string, errorDetails?: string, profile?: UserProfile) {
    if (taskId) {
      this.taskEvents.next({ taskId, status, log, errorDetails, profile });
    }
  }

  getTaskEventStream(taskId: string): Observable<{ taskId: string; status: 'running' | 'success' | 'error'; log: string; errorDetails?: string; profile?: UserProfile }> {
    return this.taskEvents.asObservable();
  }

  async runBackgroundParse(taskId: string, pdfBuffer: Buffer): Promise<void> {
    try {
      const profile = await this.parseResumePdf(pdfBuffer, taskId);
      this.emitTaskEvent(taskId, 'success', 'Profile parsing and vector indexing completed!', undefined, profile);
    } catch (err) {
      this.emitTaskEvent(taskId, 'error', `Parsing failed: ${err.message}`, err.message);
    }
  }

  getProfile(): ParsedProfile | null {
    try {
      const fs = require('fs');
      const path = require('path');
      const profilePath = path.resolve(process.cwd(), 'profile.json');
      if (fs.existsSync(profilePath)) {
        return JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      }
    } catch (err) {
      this.logger.warn(`Failed to read profile.json: ${err.message}`);
    }
    return null;
  }


  async invokeModel(promptText: string): Promise<string> {
    return this.invokeModelWithFallback(promptText);
  }


  private async invokeModelWithFallback(promptText: string): Promise<string> {
    try {
      return await this.llmGatewayService.invokeLLM(async (model) => {
        const response = await model.invoke(promptText);
        return response.content as string;
      });
    } catch (err) {
      this.logger.error(`[PROFILE: LLM] All LLM providers/keys failed: ${err.message}`);
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

    // Handle case where LLM starts with empty braces followed by properties, e.g. "{}\n\"property\": ..."
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

  async parseResumePdf(pdfBuffer: Buffer, taskId?: string): Promise<UserProfile> {
    this.emitTaskEvent(taskId, 'running', 'Extracting character streams from PDF resume...');
    this.logger.log('[PROFILE] Extracting text from PDF resume...');
    let pdfText = '';
    
    try {
      const _pdfModule = pdfParse as any;
      
      // 1. Try modern pdf-parse v2 PDFParse class syntax
      if (_pdfModule && _pdfModule.PDFParse) {
        this.logger.log('[PROFILE] Using pdf-parse v2 PDFParse class...');
        const parser = new _pdfModule.PDFParse(new Uint8Array(pdfBuffer));
        const parsed = await parser.getText();
        pdfText = parsed.text || '';
      } 
      
      // 2. Try v1 style function default export
      else if (typeof _pdfModule === 'function') {
        this.logger.log('[PROFILE] Using pdf-parse v1 function...');
        const parsedPdf = await _pdfModule(pdfBuffer);
        pdfText = parsedPdf.text || '';
      } else if (_pdfModule && typeof _pdfModule.default === 'function') {
        this.logger.log('[PROFILE] Using pdf-parse v1 default function...');
        const parsedPdf = await _pdfModule.default(pdfBuffer);
        pdfText = parsedPdf.text || '';
      } else {
        // 3. Fallback: try direct require() as a function
        try {
          const rawPdf = require('pdf-parse');
          if (typeof rawPdf === 'function') {
            this.logger.log('[PROFILE] Using require("pdf-parse") function fallback...');
            const parsedPdf = await rawPdf(pdfBuffer);
            pdfText = parsedPdf.text || '';
          } else if (rawPdf && rawPdf.PDFParse) {
            this.logger.log('[PROFILE] Using require("pdf-parse").PDFParse fallback...');
            const parser = new rawPdf.PDFParse(new Uint8Array(pdfBuffer));
            const parsed = await parser.getText();
            pdfText = parsed.text || '';
          }
        } catch (innerErr) {
          this.logger.warn(`Fallback require failed: ${innerErr.message}`);
        }
      }
      
      if (!pdfText) {
        throw new Error('Unsupported PDF parsing module structure or failed to extract text.');
      }
    } catch (e) {
      this.logger.error('[PROFILE] Failed to parse PDF resume text.', e);
      throw new Error(`PDF Parsing failed: ${e.message}`);
    }

    if (!pdfText.trim()) {
      throw new Error('PDF file appears to have no readable text content.');
    }

    this.emitTaskEvent(taskId, 'running', 'Running AI LLM parsing agent on resume content...');
    this.logger.log('[PROFILE] Structuring resume content via LLM...');

    const prompt = `You are an elite talent acquisition AI. Parse the following raw text from a candidate's resume PDF and extract it into a structured format.

Raw Resume Text:
${pdfText.substring(0, 30000)}

You MUST respond ONLY with a valid JSON object matching the following structure:
{
  "fullName": "John Doe",
  "email": "johndoe@example.com",
  "phone": "+1234567890",
  "skills": ["TypeScript", "NestJS", "PostgreSQL"],
  "experienceYears": 3.5,
  "education": ["B.Tech in Computer Science, IIT Bombay, 2022"],
  "projects": ["Built autonomous recommendation engine using pgvector"],
  "achievements": ["Ranked 1st in national level hackathon"],
  "preferredRoles": ["Software Engineer", "Backend Developer"]
}

Understand the intent of the resume and ONLY THEN DECIDE WHETHER TO ADD A PREFFERED ROLE OR NOT.Extract the experience from the WORK SECTION of the resume AND NOT FROM ANYWHERE ELSE EXPLICITLY. DO NOT GUESS OR COPY THIS EXAMPLE VALUES.DO NOT INCLUDE ANY CONVERSATIONAL FILLER, EXPLANATION, OR MARKDOWN FORMATTING (such as \`\`\`json). RETURN ONLY THE RAW JSON OBJECT.`;

    try {
      const responseText = await this.invokeModelWithFallback(prompt);
      const cleanedResponse = this.cleanJsonText(responseText);
      
      let parsedResult: any;
      try {
        parsedResult = JSON.parse(cleanedResponse);
      } catch (err) {
        this.logger.error(`JSON Parse error for resume. Raw: "${cleanedResponse}"`);
        throw err;
      }

      // Format parsed results safely
      const parseArray = (val: any): string[] => {
        if (Array.isArray(val)) return val.map(v => String(v).trim()).filter(Boolean);
        if (typeof val === 'string') {
          try {
            const parsed = JSON.parse(val);
            if (Array.isArray(parsed)) return parsed.map(v => String(v).trim()).filter(Boolean);
          } catch {}
          return val.split(',').map(s => s.trim()).filter(Boolean);
        }
        return [];
      };

      const skills = typeof parsedResult.skills === 'string'
        ? parsedResult.skills.split(',').map(s => s.trim()).filter(Boolean)
        : parseArray(parsedResult.skills);

      const profile: UserProfile = {
        fullName: String(parsedResult.fullName || '').trim(),
        email: String(parsedResult.email || '').trim().toLowerCase(),
        phone: parsedResult.phone ? String(parsedResult.phone).trim() : undefined,
        skills,
        experienceYears: parseFloat(parsedResult.experienceYears) || 0,
        education: parseArray(parsedResult.education),
        projects: parseArray(parsedResult.projects),
        achievements: parseArray(parsedResult.achievements),
        preferredRoles: [],
        preferences: {
          locations: [],
          remote: true,
          employmentTypes: ['Full-time'],
        },
      };

      // Persist profile to the database
      this.emitTaskEvent(taskId, 'running', 'Saving structured user profile and preferences to database...');
      return await this.saveProfileToDb(profile, taskId);
    } catch (e) {
      this.logger.error(`[PROFILE] Structuring failed: ${e.message}`, e.stack);
      throw new Error(`Structuring failed: ${e.message}`);
    }
  }

  async saveProfileToDb(profile: UserProfile, taskId?: string): Promise<UserProfile> {
    this.logger.log(`[PROFILE] Saving profile to database for: ${profile.fullName} (${profile.email})...`);
    const client = await this.db.getPool().connect();
    
    try {
      await client.query('BEGIN');

      // 1. Upsert into users table
      const userRes = await client.query(`
        INSERT INTO users (full_name, email, phone)
        VALUES ($1, $2, $3)
        ON CONFLICT (email)
        DO UPDATE SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone
        RETURNING id;
      `, [profile.fullName, profile.email, profile.phone]);

      const userId = userRes.rows[0].id;
      profile.id = userId;

      // 2. Delete existing preferences and skills to avoid duplicates
      await client.query('DELETE FROM user_preferences WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM user_skills WHERE user_id = $1', [userId]);

      // 3. Insert into user_preferences
      await client.query(`
        INSERT INTO user_preferences (user_id, preferred_roles, locations, remote, employment_types, salary_expectation, experience_years, education, projects, achievements)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        userId,
        profile.preferredRoles,
        profile.preferences.locations,
        profile.preferences.remote,
        profile.preferences.employmentTypes,
        profile.preferences.salaryExpectation || null,
        parseFloat(Number(profile.experienceYears || 0).toFixed(1)),
        profile.education || [],
        profile.projects || [],
        profile.achievements || []
      ]);

      // 4. Insert skills
      for (const skill of profile.skills) {
        await client.query(`
          INSERT INTO user_skills (user_id, skill)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
        `, [userId, skill]);
      }

      // 5. Generate User Embedding
      // As per requirements: "User embedding should contain: Projects, Experience, Achievements, Education, and Skills"
      const textToEmbed = [
        `Target Roles: ${profile.preferredRoles.join(', ')}`,
        `Core Skills & Keywords: ${profile.skills.join(', ')}`,
        `Education: ${profile.education.join('. ')}`,
        `Projects: ${profile.projects.join('. ')}`,
        `Achievements: ${profile.achievements.join('. ')}`,
        `Experience Years: ${profile.experienceYears}`
      ].join('\n');

      this.emitTaskEvent(taskId, 'running', 'Generating 384-dimensional vector embedding for candidate profile...');
      this.logger.log('[PROFILE] Generating User Embedding...');
      const embedding = await this.embeddingsService.generateEmbedding(textToEmbed);

      // 6. Save embedding to Qdrant vector database
      this.emitTaskEvent(taskId, 'running', 'Indexing user embedding into Qdrant vector database...');
      await this.qdrantService.getClient().upsert('user_embeddings', {
        wait: true,
        points: [
          {
            id: QdrantService.stringToUuid(userId.toString()),
            vector: embedding,
            payload: {
              fullName: profile.fullName,
              email: profile.email,
              experienceYears: profile.experienceYears,
              skills: profile.skills,
              preferredRoles: profile.preferredRoles,
            }
          }
        ]
      });

      await client.query('COMMIT');
      this.logger.log(`[PROFILE] User profile successfully stored in DB and embedding stored in Qdrant for user id: ${userId}`);
      return profile;
    } catch (err) {
      await client.query('ROLLBACK');
      this.logger.error(`[PROFILE] Failed to save profile to database: ${err.message}`, err.stack);
      throw err;
    } finally {
      client.release();
    }
  }

  async getProfileById(userId: number): Promise<UserProfile | null> {
    try {
      const userRes = await this.db.query('SELECT * FROM users WHERE id = $1', [userId]);
      if (userRes.rows.length === 0) return null;

      const user = userRes.rows[0];
      const prefRes = await this.db.query('SELECT * FROM user_preferences WHERE user_id = $1', [userId]);
      const skillsRes = await this.db.query('SELECT skill FROM user_skills WHERE user_id = $1', [userId]);

      const pref = prefRes.rows[0] || {
        preferred_roles: [],
        locations: [],
        remote: true,
        employment_types: ['Full-time'],
        salary_expectation: null,
        experience_years: 0,
        education: [],
        projects: [],
        achievements: [],
      };

      const skills = skillsRes.rows.map(r => r.skill);

      return {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        phone: user.phone,
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
          salaryExpectation: pref.salary_expectation || undefined,
        },
      };
    } catch (err) {
      this.logger.error(`[PROFILE] Failed to load user profile: ${err.message}`);
      return null;
    }
  }

  async getProfileByEmail(email: string): Promise<UserProfile | null> {
    try {
      const userRes = await this.db.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
      if (userRes.rows.length === 0) return null;
      return this.getProfileById(userRes.rows[0].id);
    } catch (err) {
      this.logger.error(`[PROFILE] Failed to load user profile by email: ${err.message}`);
      return null;
    }
  }

  async suggestJobTitles(profile: UserProfile): Promise<string[]> {
    if (!profile || !profile.email) {
      this.logger.warn('[PROFILE] Cannot suggest job titles: No active profile found.');
      return [];
    }

    const activeProfile = profile;
    this.logger.log(`[PROFILE] Generating title suggestions for role: "${activeProfile.preferredRoles.join(', ')}"...`);

    const prompt = PromptTemplate.fromTemplate(`
      You are an elite career advisor. Based on the candidate's preferences below, suggest exactly 1 single, most relevant, specific, standard, industry-common job title search term to query job boards.
      Focus on the single best term that matches their skills and preferred roles (e.g. "Full Stack Developer", "Backend Developer", "Node.js Developer", "React Developer", or "Software Engineer").
      Do NOT suggest rare, highly-specialized, or niche titles unless the candidate has extensive professional experience in those specific areas.
      Do NOT suggest project names, specific technologies that are not job titles, or candidate achievements as search terms. Every suggestion MUST be a standard, widely-recognized job title.
      
      Candidate Profile:
      - Preferred Roles: {preferredRoles}
      - Skills: {skills}
      - Experience Years: {experienceYears}
      
      Respond ONLY with a JSON array of strings containing exactly 1 suggested job title (e.g. ["Software Engineer"]).
      Do not include any conversational filler, markdown code blocks, or schema definitions. Just return the valid JSON array of strings.
    `);

    const formattedPrompt = await prompt.format({
      preferredRoles: activeProfile.preferredRoles.join(', '),
      skills: activeProfile.skills.join(', '),
      experienceYears: activeProfile.experienceYears,
    });

    try {
      const responseText = await this.invokeModelWithFallback(formattedPrompt);
      const cleanedResponse = this.cleanJsonText(responseText);
      const parsed = JSON.parse(cleanedResponse);
      if (Array.isArray(parsed)) {
        return parsed.map(t => String(t).trim()).filter(Boolean);
      }
      return activeProfile.preferredRoles;
    } catch (e) {
      this.logger.error(`[PROFILE] Failed to suggest titles: ${e.message}`);
      return activeProfile.preferredRoles;
    }
  }
}