import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../vector-store/database.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { QdrantService } from '../vector-store/qdrant.service';
import { LlmGatewayService } from '../llm-gateway/llm-gateway.service';
import { CryptoService } from '../crypto/crypto.service';
import { redactPii } from '../utils/pii-redactor.utility';
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
  suggestedTitles?: string[];
  preferences: {
    locations: string[];
    remote: boolean;
    employmentTypes: string[];
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
  private readonly taskHistories = new Map<string, Array<{ taskId: string; status: 'running' | 'success' | 'error'; log: string; errorDetails?: string; profile?: UserProfile }>>();

  constructor(
    private readonly db: DatabaseService,
    private readonly embeddingsService: EmbeddingsService,
    private readonly qdrantService: QdrantService,
    private readonly llmGatewayService: LlmGatewayService,
    private readonly cryptoService: CryptoService,
  ) {}

  emitTaskEvent(taskId: string | undefined, status: 'running' | 'success' | 'error', log: string, errorDetails?: string, profile?: UserProfile) {
    if (taskId) {
      const event = { taskId, status, log, errorDetails, profile };
      
      // Store in history
      if (!this.taskHistories.has(taskId)) {
        this.taskHistories.set(taskId, []);
      }
      this.taskHistories.get(taskId)!.push(event);

      // Emit to active subscribers
      this.taskEvents.next(event);

      // Clean up memory if task is complete
      if (status === 'success' || status === 'error') {
        setTimeout(() => {
          this.taskHistories.delete(taskId);
        }, 60000); // Keep history for 1 minute after completion
      }
    }
  }

  getTaskEventStream(taskId: string): Observable<{ taskId: string; status: 'running' | 'success' | 'error'; log: string; errorDetails?: string; profile?: UserProfile }> {
    const history = this.taskHistories.get(taskId) || [];
    return new Observable(subscriber => {
      // First, emit all historical events
      for (const event of history) {
        subscriber.next(event);
      }
      // Then, subscribe to new events
      const sub = this.taskEvents.subscribe({
        next: (event) => subscriber.next(event),
        error: (err) => subscriber.error(err),
        complete: () => subscriber.complete(),
      });
      return () => sub.unsubscribe();
    });
  }

  async runBackgroundParse(taskId: string, pdfBuffer: Buffer, originalFilename?: string, customVersionName?: string, targetUserEmail?: string): Promise<void> {
    try {
      const profile = await this.parseResumePdf(pdfBuffer, taskId, originalFilename, customVersionName, targetUserEmail);
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
    return this.invokeModelWithFallback(promptText, 'general');
  }

  private async invokeModelWithFallback(promptText: string, purpose?: 'resume-parsing' | 'general'): Promise<string> {
    try {
      return await this.llmGatewayService.invokeLLM(async (model) => {
        const response = await model.invoke(promptText);
        return response.content as string;
      }, 2, { purpose });
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
      
      // Try to find the matching closing brace/bracket and truncate trailing text
      let inString = false;
      let escape = false;
      const stack: string[] = [];
      let endOfJson = -1;

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
              if (stack.length === 0) {
                endOfJson = i + 1;
                break;
              }
            }
          } else if (char === ']') {
            if (stack[stack.length - 1] === '[') {
              stack.pop();
              if (stack.length === 0) {
                endOfJson = i + 1;
                break;
              }
            }
          }
        }
      }
      
      if (endOfJson !== -1) {
        cleaned = cleaned.substring(0, endOfJson);
      }
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

  async parseResumePdf(pdfBuffer: Buffer, taskId?: string, originalFilename?: string, customVersionName?: string, targetUserEmail?: string): Promise<UserProfile> {
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

    if (!pdfText || pdfText.trim().length < 50) {
      throw new Error('PDF file appears to have no readable text content (e.g. scanned image PDF). Please upload a PDF with selectable text.');
    }

    // Senior QA Guardrail: Non-Resume PDF Detection (invoices, bills, tax forms, ebooks)
    const lowerText = pdfText.toLowerCase();
    const resumeKeywords = ['experience', 'education', 'skills', 'projects', 'work', 'employment', 'university', 'college', 'bachelor', 'master', 'engineer', 'developer', 'summary', 'profile', 'curriculum', 'vitae', 'resume'];
    const hasResumeKeywords = resumeKeywords.some(kw => lowerText.includes(kw));

    if (!hasResumeKeywords && lowerText.length > 200) {
      this.logger.warn(`[PROFILE QA GUARD] Non-resume PDF content detected. Snippet: "${pdfText.substring(0, 150)}..."`);
      throw new Error('The uploaded document does not appear to be a candidate resume (missing work experience, education, or skills sections). Please upload a valid resume PDF.');
    }

    this.emitTaskEvent(taskId, 'running', 'Running AI LLM parsing agent on resume content...');
    this.logger.log('[PROFILE] Structuring resume content via LLM...');

    const prompt = `Parse the following resume text into a JSON object.
Resume:${pdfText.substring(0, 8000)}.Return ONLY a valid JSON object with this schema:{"fullName": "","email": "","phone": "","skills": [],"experienceYears": 0,"education": [],"projects": [],"achievements": [],"preferredRoles": []}
Rules:Return ONLY raw JSON. No markdown or explanations.Never use example values or invent information.Extract "experienceYears" ONLY from the Work Experience / Employment / Professional Experience/Summary section/Calculate the duration of work experience in years, if not then populate to 0. Do NOT infer it from graduation year, projects, internships (unless listed as work experience), skills, certifications, or any other section.Populate "preferredRoles" based on the candidate's career objective, target roles, or inferred from their most recent professional experience titles and skill set (e.g., if their latest title is "ML Engineer Intern" and skills are PyTorch/TensorFlow, include "Machine Learning Engineer"). Extract only information explicitly present or directly implied in the resume.Use empty arrays for missing list fields and empty strings for missing string fields.`;

    try {
      const responseText = await this.invokeModelWithFallback(prompt, 'resume-parsing');
      const cleanedResponse = this.cleanJsonText(responseText);
      
      let parsedResult: any;
      try {
        parsedResult = JSON.parse(cleanedResponse);
      } catch (err) {
        this.logger.error(`JSON Parse error for resume. Raw: "${cleanedResponse}"`);
        throw err;
      }

      // Format parsed results safely without converting objects to [object Object]
      const formatItem = (v: any): string => {
        if (typeof v === 'string') return v.trim();
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (v && typeof v === 'object') {
          const parts: string[] = [];
          if (v.degree || v.title || v.name || v.role) {
            parts.push(v.degree || v.title || v.name || v.role);
          }
          if (v.institution || v.university || v.school || v.company) {
            parts.push(v.institution || v.university || v.school || v.company);
          }
          if (v.year || v.duration || v.date) {
            parts.push(`(${v.year || v.duration || v.date})`);
          }
          if (v.description || v.summary || v.details) {
            parts.push(`- ${v.description || v.summary || v.details}`);
          }
          if (v.techStack && Array.isArray(v.techStack)) {
            parts.push(`[Stack: ${v.techStack.join(', ')}]`);
          }
          if (parts.length > 0) return parts.join(' ');
          try {
            return JSON.stringify(v);
          } catch {
            return String(v);
          }
        }
        return '';
      };

      const parseArray = (val: any): string[] => {
        if (Array.isArray(val)) return val.map(v => formatItem(v)).filter(Boolean);
        if (typeof val === 'string') {
          try {
            const parsed = JSON.parse(val);
            if (Array.isArray(parsed)) return parsed.map(v => formatItem(v)).filter(Boolean);
          } catch {}
          return val.split(',').map(s => s.trim()).filter(Boolean);
        }
        return [];
      };

      const pdfExtractedEmail = String(parsedResult.email || '').trim().toLowerCase();
      const emailLower = (targetUserEmail || pdfExtractedEmail || '').trim().toLowerCase();
      const existingProfile = emailLower ? await this.getProfileByEmail(emailLower) : null;
      console.log(`
[TRACE] before_resume_upload:
canonical_role: ${existingProfile ? JSON.stringify(existingProfile.preferredRoles) : 'None'}
`);

      const skills = typeof parsedResult.skills === 'string'
        ? parsedResult.skills.split(',').map(s => s.trim()).filter(Boolean)
        : parseArray(parsedResult.skills);

      let preferredRoles = parseArray(parsedResult.preferredRoles);
      if (preferredRoles.length === 0 && parsedResult.targetRole) {
        preferredRoles = [String(parsedResult.targetRole).trim()];
      }
      if (preferredRoles.length === 0 && skills.length > 0) {
        const skillStr = skills.join(' ').toLowerCase();
        if (skillStr.includes('react') || skillStr.includes('javascript') || skillStr.includes('typescript') || skillStr.includes('frontend')) {
          preferredRoles = ['Software Engineer', 'Frontend Developer', 'Full Stack Engineer'];
        } else if (skillStr.includes('python') || skillStr.includes('c++') || skillStr.includes('java') || skillStr.includes('node')) {
          preferredRoles = ['Software Engineer', 'Backend Engineer', 'Systems Engineer'];
        } else {
          preferredRoles = ['Software Engineer'];
        }
      }
      if (preferredRoles.length === 0) {
        preferredRoles = ['Software Engineer'];
      }

      const profile: UserProfile = {
        fullName: String(parsedResult.fullName || '').trim(),
        email: emailLower,
        phone: parsedResult.phone ? String(parsedResult.phone).trim() : undefined,
        skills,
        experienceYears: parseFloat(parsedResult.experienceYears) || 0,
        education: parseArray(parsedResult.education),
        projects: parseArray(parsedResult.projects),
        achievements: parseArray(parsedResult.achievements),
        preferredRoles,
        preferences: {
          locations: [],
          remote: true,
          employmentTypes: ['Full-time'],
        },
      };

      // Persist profile to the database
      this.emitTaskEvent(taskId, 'running', 'Saving structured user profile and preferences to database...');
      const savedProfile = await this.saveProfileToDb(profile, taskId);
      
      // Save version to resume_versions table
      if (savedProfile.id) {
        const requestedName = customVersionName || originalFilename || 'Resume.pdf';
        await this.saveResumeVersion(savedProfile.id, requestedName, savedProfile, pdfText, true);
      }

      console.log(`
[TRACE] after_resume_upload:
canonical_role: ${JSON.stringify(savedProfile.preferredRoles)}
`);

      return savedProfile;
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

      // Ensure column types in PostgreSQL can store encrypted ciphertext strings
      await client.query(`
        ALTER TABLE users ALTER COLUMN full_name TYPE TEXT;
        ALTER TABLE users ALTER COLUMN phone TYPE TEXT;
      `).catch(() => {});

      // 1. Upsert into users table with AES-256-GCM encrypted PII
      const encryptedName = this.cryptoService.encryptSymmetric(profile.fullName);
      const encryptedPhone = this.cryptoService.encryptSymmetric(profile.phone || '');

      const userRes = await client.query(`
        INSERT INTO users (full_name, email, phone)
        VALUES ($1, $2, $3)
        ON CONFLICT (email)
        DO UPDATE SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone
        RETURNING id;
      `, [encryptedName, profile.email, encryptedPhone]);

      const userId = userRes.rows[0].id;
      profile.id = userId;

      // 2. Delete existing preferences and skills to avoid duplicates
      await client.query('DELETE FROM user_preferences WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM user_skills WHERE user_id = $1', [userId]);

      // 3. Insert into user_preferences
      await client.query(`
        INSERT INTO user_preferences (user_id, preferred_roles, locations, remote, employment_types, experience_years, education, projects, achievements)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        userId,
        profile.preferredRoles,
        profile.preferences.locations,
        profile.preferences.remote,
        profile.preferences.employmentTypes,
        parseFloat(Number(profile.experienceYears || 0).toFixed(1)),
        profile.education || [],
        profile.projects || [],
        profile.achievements || []
      ]);

      // 4. Insert skills
      for (const rawSkill of profile.skills) {
        const skill = String(rawSkill || '').trim().substring(0, 255);
        if (!skill) continue;
        await client.query(`
          INSERT INTO user_skills (user_id, skill)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
        `, [userId, skill]);
      }

      // 5. Generate User Embedding with PII Redaction
      const textToEmbed = redactPii([
        `Target Roles: ${profile.preferredRoles.join(', ')}`,
        `Core Skills & Keywords: ${profile.skills.join(', ')}`,
        `Education: ${profile.education.join('. ')}`,
        `Projects: ${profile.projects.join('. ')}`,
        `Achievements: ${profile.achievements.join('. ')}`,
        `Experience Years: ${profile.experienceYears}`
      ].join('\n'));

      this.emitTaskEvent(taskId, 'running', 'Generating 384-dimensional vector embedding for candidate profile...');
      this.logger.log('[PROFILE] Generating User Embedding...');
      const embedding = await this.embeddingsService.generateEmbedding(textToEmbed);
      (profile as any).embedding = embedding;

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
        experience_years: 0,
        education: [],
        projects: [],
        achievements: [],
      };

      const skills = skillsRes.rows.map(r => r.skill);

      const decryptedName = this.cryptoService.decryptSymmetric(user.full_name);
      const decryptedPhone = this.cryptoService.decryptSymmetric(user.phone);

      return {
        id: user.id,
        fullName: decryptedName,
        email: user.email,
        phone: decryptedPhone,
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

    // Optimization: Return cached title suggestions from DB cache instantly (< 1ms) without calling LLM
    if (profile.suggestedTitles && Array.isArray(profile.suggestedTitles) && profile.suggestedTitles.length > 0) {
      this.logger.log(`[PROFILE] Returning ${profile.suggestedTitles.length} cached title suggestions from DB cache (Instant).`);
      return profile.suggestedTitles;
    }

    const activeProfile = profile;
    this.logger.log(`[PROFILE] Generating title suggestions for role: "${activeProfile.preferredRoles.join(', ')}"...`);

    // Instant non-LLM title generator from skills & preferred roles
    const suggestionsSet = new Set<string>();
    activeProfile.preferredRoles.forEach(r => suggestionsSet.add(r));

    const skillStr = (activeProfile.skills || []).join(' ').toLowerCase();
    if (skillStr.includes('react') || skillStr.includes('javascript') || skillStr.includes('frontend')) {
      suggestionsSet.add('Frontend Developer');
      suggestionsSet.add('Full Stack Engineer');
    }
    if (skillStr.includes('python') || skillStr.includes('c++') || skillStr.includes('java') || skillStr.includes('node')) {
      suggestionsSet.add('Backend Engineer');
      suggestionsSet.add('Software Engineer');
      suggestionsSet.add('Systems Engineer');
    }
    if (activeProfile.experienceYears >= 5) {
      suggestionsSet.add('Senior Software Engineer');
    } else {
      suggestionsSet.add('SDE');
      suggestionsSet.add('Software Engineer');
    }

    const suggestions = Array.from(suggestionsSet);
    activeProfile.suggestedTitles = suggestions;
    return suggestions;
  }

  async getUniqueVersionName(userId: number, requestedName: string): Promise<string> {
    let name = requestedName.trim();
    if (!name) name = 'Resume.pdf';

    const existingRes = await this.db.query(
      'SELECT version_name FROM resume_versions WHERE user_id = $1',
      [userId]
    );
    const existingNames = new Set(existingRes.rows.map(r => r.version_name.toLowerCase()));

    if (!existingNames.has(name.toLowerCase())) {
      return name;
    }

    const lastDot = name.lastIndexOf('.');
    let baseName = name;
    let ext = '';
    if (lastDot > 0) {
      baseName = name.substring(0, lastDot);
      ext = name.substring(lastDot);
    }

    let count = 1;
    let candidate = `${baseName} (${count})${ext}`;
    while (existingNames.has(candidate.toLowerCase())) {
      count++;
      candidate = `${baseName} (${count})${ext}`;
    }

    return candidate;
  }

  async saveResumeVersion(
    userId: number,
    versionName: string,
    profile: UserProfile,
    rawText?: string,
    makeActive: boolean = true
  ): Promise<any> {
    const client = await this.db.getPool().connect();
    try {
      await client.query('BEGIN');

      if (makeActive) {
        await client.query('UPDATE resume_versions SET is_active = false WHERE user_id = $1', [userId]);
      }

      const finalVersionName = await this.getUniqueVersionName(userId, versionName);

      const encryptedRawText = this.cryptoService.encryptSymmetric(rawText || '');

      const res = await client.query(`
        INSERT INTO resume_versions (user_id, version_name, is_active, raw_text, parsed_data)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *;
      `, [userId, finalVersionName, makeActive, encryptedRawText, JSON.stringify(profile)]);

      await client.query('COMMIT');
      return res.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      this.logger.error(`[PROFILE: VERSION] Failed to save resume version: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  async getUserVersions(userId: number): Promise<any[]> {
    try {
      const res = await this.db.query(
        'SELECT id, version_name as "versionName", is_active as "isActive", created_at as "createdAt", updated_at as "updatedAt", parsed_data as "parsedData" FROM resume_versions WHERE user_id = $1 ORDER BY is_active DESC, created_at DESC',
        [userId]
      );
      return res.rows;
    } catch (err) {
      this.logger.error(`[PROFILE: VERSION] Failed to list resume versions: ${err.message}`);
      return [];
    }
  }

  async activateResumeVersion(userId: number, versionId: number): Promise<UserProfile | null> {
    const client = await this.db.getPool().connect();
    try {
      await client.query('BEGIN');

      await client.query('UPDATE resume_versions SET is_active = false WHERE user_id = $1', [userId]);
      const res = await client.query(
        'UPDATE resume_versions SET is_active = true, updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING parsed_data',
        [versionId, userId]
      );

      await client.query('COMMIT');

      if (res.rows.length === 0) return null;

      const profile: UserProfile & { embedding?: number[] } = res.rows[0].parsed_data;
      profile.id = userId;

      // Optimization: Reuse stored pre-computed vector embedding if available
      if (profile.embedding && Array.isArray(profile.embedding) && profile.embedding.length > 0) {
        this.logger.log(`[PROFILE: VERSION] Reusing pre-computed 384-dimensional vector embedding for version ${versionId} (Instant switch).`);
        await this.syncProfilePreferencesAndVector(userId, profile, profile.embedding);
      } else {
        await this.saveProfileToDb(profile);
      }

      return profile;
    } catch (err) {
      await client.query('ROLLBACK');
      this.logger.error(`[PROFILE: VERSION] Failed to activate version: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  private async syncProfilePreferencesAndVector(userId: number, profile: UserProfile, embedding: number[]) {
    const client = await this.db.getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM user_preferences WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM user_skills WHERE user_id = $1', [userId]);

      await client.query(`
        INSERT INTO user_preferences (user_id, preferred_roles, locations, remote, employment_types, experience_years, education, projects, achievements)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        userId,
        profile.preferredRoles,
        profile.preferences?.locations || [],
        profile.preferences?.remote ?? true,
        profile.preferences?.employmentTypes || ['Full-time'],
        parseFloat(Number(profile.experienceYears || 0).toFixed(1)),
        profile.education || [],
        profile.projects || [],
        profile.achievements || []
      ]);

      for (const rawSkill of profile.skills) {
        const skill = String(rawSkill || '').trim().substring(0, 255);
        if (!skill) continue;
        await client.query(`
          INSERT INTO user_skills (user_id, skill)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
        `, [userId, skill]);
      }

      await client.query('COMMIT');

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
    } catch (err: any) {
      await client.query('ROLLBACK');
      this.logger.error(`[PROFILE] Failed syncing cached vector: ${err.message}`);
    } finally {
      client.release();
    }
  }

  async renameResumeVersion(userId: number, versionId: number, newName: string): Promise<boolean> {
    try {
      const uniqueName = await this.getUniqueVersionName(userId, newName);
      const res = await this.db.query(
        'UPDATE resume_versions SET version_name = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
        [uniqueName, versionId, userId]
      );
      return (res.rowCount ?? 0) > 0;
    } catch (err) {
      this.logger.error(`[PROFILE: VERSION] Failed to rename version: ${err.message}`);
      return false;
    }
  }

  async deleteResumeVersion(userId: number, versionId: number): Promise<boolean> {
    const client = await this.db.getPool().connect();
    try {
      await client.query('BEGIN');

      const checkRes = await client.query(
        'SELECT is_active FROM resume_versions WHERE id = $1 AND user_id = $2',
        [versionId, userId]
      );

      if (checkRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return false;
      }

      const wasActive = checkRes.rows[0].is_active;

      await client.query('DELETE FROM resume_versions WHERE id = $1 AND user_id = $2', [versionId, userId]);

      if (wasActive) {
        const remaining = await client.query(
          'SELECT id FROM resume_versions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
          [userId]
        );
        if (remaining.rows.length > 0) {
          const nextActiveId = remaining.rows[0].id;
          await client.query('UPDATE resume_versions SET is_active = true WHERE id = $1', [nextActiveId]);
        }
      }

      await client.query('COMMIT');

      const remainingProfile = await this.getProfileById(userId);
      if (remainingProfile && wasActive) {
        await this.saveProfileToDb(remainingProfile);
      }

      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      this.logger.error(`[PROFILE: VERSION] Failed to delete version: ${err.message}`);
      return false;
    } finally {
      client.release();
    }
  }
}