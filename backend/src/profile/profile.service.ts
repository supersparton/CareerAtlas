import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../vector-store/database.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { ChatGroq } from '@langchain/groq';
import { PromptTemplate } from '@langchain/core/prompts';
import { StructuredOutputParser } from '@langchain/core/output_parsers';
import * as _pdf from 'pdf-parse';

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
  targetRole: string;
  coreSkills: string[];
  experienceLevel: string;
  preferences: string;
  targetLocation: string;
  isRemoteOpen: boolean;
  experience: any[];
  projects: any[];
  education?: any[];
}

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);
  private model: ChatGroq;

  constructor(
    private readonly db: DatabaseService,
    private readonly embeddingsService: EmbeddingsService,
  ) {
    this.model = new ChatGroq({
      apiKey: process.env.GROQ_API_KEY,
      model: 'llama-3.3-70b-versatile',
      temperature: 0,
    });
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

  private async getProfileForSuggestions(): Promise<UserProfile | null> {
    const raw = this.getProfile();
    if (!raw) return null;
    return {
      fullName: raw.fullName,
      email: raw.email,
      skills: raw.coreSkills || [],
      experienceYears: raw.experienceLevel?.toLowerCase().includes('senior') ? 6 : 2,
      education: [],
      projects: [],
      achievements: [],
      preferredRoles: raw.targetRole ? [raw.targetRole] : [],
      preferences: {
        locations: raw.targetLocation ? [raw.targetLocation] : [],
        remote: raw.isRemoteOpen ?? true,
        employmentTypes: ['Full-time'],
      }
    };
  }

  async invokeModel(promptText: string): Promise<string> {
    return this.invokeModelWithFallback(promptText);
  }


  private async invokeOllama(promptText: string): Promise<string> {
    const ollamaUrl = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
    const ollamaModel = process.env.OLLAMA_MODEL || 'llama3';
    this.logger.log(`[PROFILE: LLM] Attempting local Ollama call with model "${ollamaModel}"...`);

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
        this.logger.warn(`[PROFILE: LLM] Local Ollama failed: ${err.message}. Falling back to standard API...`);
      }
    }

    try {
      this.logger.log('[PROFILE: LLM] Invoking Groq model (Secondary)...');
      const response = await this.model.invoke(promptText);
      return response.content as string;
    } catch (err) {
      this.logger.error(`[PROFILE: LLM] Groq API exception: ${err.message}.`);
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

  async parseResumePdf(pdfBuffer: Buffer): Promise<UserProfile> {
    this.logger.log('[PROFILE] Extracting text from PDF resume...');
    let pdfText = '';
    
    try {
      const _pdfModule = _pdf as any;
      
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
  "preferredRoles": ["Software Engineer", "Backend Developer"],
  "preferredLocations": [],
  "remote": true,
  "employmentTypes": ["Full-time"],
  "salaryExpectation": null
}

If any preference (such as preferredLocations or salaryExpectation or preferredRoles) is not explicitly mentioned in the resume text, you MUST return them as [] or null as shown above.Understand the intent of the resume and ONLY THEN DECIDE WHETHER TO ADD A PREFFERED ROLE OR NOT.Extract the experience from the WORK SECTION of the resume AND NOT FROM ANYWHERE ELSE EXPLICITLY. DO NOT GUESS OR COPY THIS EXAMPLE VALUES.ALSO DO NOT ADD PREFFERED ROLES IF NOT EXPLICITLY MENTIONED IN THE RESUME.DO NOT INCLUDE ANY CONVERSATIONAL FILLER, EXPLANATION, OR MARKDOWN FORMATTING (such as \`\`\`json). RETURN ONLY THE RAW JSON OBJECT.`;

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
        preferredRoles: parseArray(parsedResult.preferredRoles),
        preferences: {
          locations: parseArray(parsedResult.preferredLocations),
          remote: typeof parsedResult.remote === 'boolean' ? parsedResult.remote : String(parsedResult.remote).toLowerCase() === 'true',
          employmentTypes: parseArray(parsedResult.employmentTypes).length > 0 ? parseArray(parsedResult.employmentTypes) : ['Full-time'],
          salaryExpectation: parsedResult.salaryExpectation ? parseInt(String(parsedResult.salaryExpectation), 10) : undefined,
        },
      };

      // Persist profile to the database
      return await this.saveProfileToDb(profile);
    } catch (e) {
      this.logger.error(`[PROFILE] Structuring failed: ${e.message}`, e.stack);
      throw new Error(`Structuring failed: ${e.message}`);
    }
  }

  async saveProfileToDb(profile: UserProfile): Promise<UserProfile> {
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
        INSERT INTO user_preferences (user_id, preferred_roles, locations, remote, employment_types, salary_expectation, experience_years)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        userId,
        profile.preferredRoles,
        profile.preferences.locations,
        profile.preferences.remote,
        profile.preferences.employmentTypes,
        profile.preferences.salaryExpectation || null,
        Math.round(profile.experienceYears)
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
      // As per requirements: "User embedding should contain: Projects, Experience, Achievements, Education"
      const textToEmbed = [
        `Target Roles: ${profile.preferredRoles.join(', ')}`,
        `Education: ${profile.education.join('. ')}`,
        `Projects: ${profile.projects.join('. ')}`,
        `Achievements: ${profile.achievements.join('. ')}`,
        `Experience Years: ${profile.experienceYears}`
      ].join('\n');

      this.logger.log('[PROFILE] Generating User Embedding...');
      const embedding = await this.embeddingsService.generateEmbedding(textToEmbed);

      // 6. Save embedding
      const formattedVector = `[${embedding.join(',')}]`;
      await client.query(`
        INSERT INTO user_embeddings (user_id, embedding)
        VALUES ($1, $2)
        ON CONFLICT (user_id)
        DO UPDATE SET embedding = EXCLUDED.embedding, created_at = CURRENT_TIMESTAMP
      `, [userId, formattedVector]);

      await client.query('COMMIT');
      this.logger.log(`[PROFILE] User profile and embedding successfully stored in DB for user id: ${userId}`);
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
      };

      const skills = skillsRes.rows.map(r => r.skill);

      return {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        phone: user.phone,
        skills,
        experienceYears: pref.experience_years,
        education: [], // Populated from raw profile context if needed
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

  async suggestJobTitles(profile?: UserProfile): Promise<string[]> {
    const activeProfile = profile || await this.getProfileForSuggestions();
    if (!activeProfile) {
      this.logger.warn('[PROFILE] Cannot suggest job titles: No active profile found.');
      return [];
    }

    this.logger.log(`[PROFILE] Generating title suggestions for role: "${activeProfile.preferredRoles.join(', ')}"...`);

    const prompt = PromptTemplate.fromTemplate(`
      You are an elite career advisor. Based on the candidate's preferences below, suggest 4 to 6 specific, standard, industry-common job title search terms to query job boards.
      Focus on terms that match their skills and preferred roles(if found any from the profile). E.g. "Full Stack Developer", "Backend Developer", "Node.js Developer", "React Developer", "Software Engineer".
      Do NOT suggest rare, highly-specialized, or niche titles (such as "Agentic AI Developer", "Generative AI Engineer", "LLM Specialist") unless the candidate has extensive professional experience in those specific areas.
      Do NOT suggest project names, specific technologies that are not job titles, or candidate achievements as search terms. Every suggestion MUST be a standard, widely-recognized job title.
      
      Candidate Profile:
      - Preferred Roles: {preferredRoles}
      - Skills: {skills}
      - Experience Years: {experienceYears}
      
      Respond ONLY with a JSON array of strings containing the job titles.
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
