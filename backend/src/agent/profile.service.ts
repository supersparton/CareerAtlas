import { Injectable, Logger } from '@nestjs/common';
import { ChatGroq } from '@langchain/groq';
import { PromptTemplate } from '@langchain/core/prompts';
import { StructuredOutputParser } from '@langchain/core/output_parsers';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as _pdf from 'pdf-parse';

export interface ResumeWorkExperience {
  company: string;
  role: string;
  duration: string;
  description: string;
}

export interface ResumeProject {
  title: string;
  techStack: string[];
  description: string;
}

export interface ResumeEducation {
  institution: string;
  degree: string;
  year: string;
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
  experience: ResumeWorkExperience[];
  projects: ResumeProject[];
  education: ResumeEducation[];
}

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);
  private model: ChatGroq;
  private readonly profileJsonPath = path.join(process.cwd(), '..', 'profile.json');

  constructor() {
    this.model = new ChatGroq({
      apiKey: process.env.GROQ_API_KEY,
      model: 'llama-3.3-70b-versatile',
      temperature: 0,
    });
  }

  private async invokeOllama(promptText: string): Promise<string> {
    const ollamaUrl = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
    const ollamaModel = process.env.OLLAMA_MODEL || 'llama3';
    this.logger.log(`[LLM] Attempting local Ollama call with model "${ollamaModel}"...`);

    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
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
    const text = data.response;
    if (!text) {
      throw new Error('Ollama returned empty response');
    }
    this.logger.log('[LLM] Ollama call succeeded.');
    return text;
  }

  private async invokeModelWithFallback(promptText: string): Promise<string> {
    const useOllama = process.env.USE_OLLAMA === 'true';

    if (useOllama) {
      try {
        return await this.invokeOllama(promptText);
      } catch (err) {
        this.logger.warn(`[LLM] Local Ollama failed: ${err.message}. Falling back to standard API chain...`);
      }
    }

    const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (geminiApiKey) {
      this.logger.log('[LLM] Attempting Gemini API call (Primary)...');
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              contents: [{
                parts: [{
                  text: promptText
                }]
              }]
            }),
          }
        );

        if (response.ok) {
          const data = await response.json();
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            this.logger.log('[LLM] Gemini API call succeeded.');
            return text;
          }
        }
        
        const errText = await response.text();
        this.logger.warn(`[LLM] Gemini API failed with status ${response.status}: ${errText}. Falling back to Groq...`);
      } catch (err) {
        this.logger.warn(`[LLM] Gemini API exception: ${err.message}. Falling back to Groq...`);
      }
    } else {
      this.logger.log('[LLM] GEMINI_API_KEY/GOOGLE_API_KEY not configured. Using Groq as secondary...');
    }

    // Secondary provider: Groq
    try {
      this.logger.log('[LLM] Invoking Groq model (Secondary)...');
      const response = await this.model.invoke(promptText);
      return response.content as string;
    } catch (err) {
      this.logger.warn(`[LLM] Groq API exception: ${err.message}.`);
      if (!useOllama) {
        this.logger.log('[LLM] Attempting local Ollama as final fallback...');
        try {
          return await this.invokeOllama(promptText);
        } catch (ollamaErr) {
          this.logger.error(`[LLM] Final Ollama fallback also failed: ${ollamaErr.message}`);
        }
      }
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

  // 1. Parses a PDF buffer to extract text, then uses LLM to structure it into JSON
  async parseResumePdf(pdfBuffer: Buffer): Promise<ParsedProfile> {
    this.logger.log('[PROFILE] Extracting text from PDF resume...');
    let pdfText = '';
    try {
      // Resolve and call the appropriate PDF parser function or class based on library version
      const _pdfModule = _pdf as any;
      if (typeof _pdfModule === 'function') {
        const parsedPdf = await _pdfModule(pdfBuffer);
        pdfText = parsedPdf.text || '';
      } else if (_pdfModule.default && typeof _pdfModule.default === 'function') {
        const parsedPdf = await _pdfModule.default(pdfBuffer);
        pdfText = parsedPdf.text || '';
      } else if (_pdfModule.PDFParse && typeof _pdfModule.PDFParse === 'function') {
        const instance = new _pdfModule.PDFParse({ data: pdfBuffer });
        const result = await instance.getText();
        pdfText = result.text || '';
      } else if (_pdfModule.default && _pdfModule.default.PDFParse && typeof _pdfModule.default.PDFParse === 'function') {
        const instance = new _pdfModule.default.PDFParse({ data: pdfBuffer });
        const result = await instance.getText();
        pdfText = result.text || '';
      } else {
        throw new Error('No supported PDF parsing function or class found in pdf-parse module.');
      }
    } catch (e) {
      this.logger.error('[PROFILE] Failed to parse PDF file text.', e);
      throw new Error(`PDF Parsing failed: ${e.message}`);
    }

    if (!pdfText.trim()) {
      throw new Error('PDF file appears to have no readable text content.');
    }

    this.logger.log('[PROFILE] Sending raw text to Groq LLM for structured resume parsing...');
    const parser = StructuredOutputParser.fromNamesAndDescriptions({
      fullName: 'string, candidate full name',
      email: 'string, email address',
      phone: 'string, phone number',
      targetRole: 'string, primary job title or role candidate is targeting',
      coreSkills: 'comma-separated list of top technical skills, programming languages, and frameworks',
      experienceLevel: 'string, general experience level (e.g. Junior (0-2 years), Mid-level (3-5 years), Senior (5+ years))',
      preferences: 'string, job preference string (e.g., Onsite in Ahmedabad, Hybrid in Bangalore, Remote open)',
      experience: 'JSON array of objects, each with keys: company, role, duration, description. Professional work history.',
      projects: 'JSON array of objects, each with keys: title, techStack (array of strings), description. Key personal/academic/professional projects.',
      education: 'JSON array of objects, each with keys: institution, degree, year. Educational qualifications.',
    });

    const prompt = PromptTemplate.fromTemplate(`
      You are an elite talent acquisition AI. Parse the following raw text from a candidate's resume PDF and extract it into a structured format.
      
      Raw Resume Text:
      {pdfText}
      
      {format_instructions}
    `);

    const formattedPrompt = await prompt.format({
      pdfText: pdfText.substring(0, 30000), // Safety truncation for context window
      format_instructions: parser.getFormatInstructions(),
    });

    try {
      const responseText = await this.invokeModelWithFallback(formattedPrompt);
      const cleanedResponse = this.cleanJsonText(responseText);
      
      let parsedResult: any;
      try {
        parsedResult = JSON.parse(cleanedResponse);
      } catch (err) {
        this.logger.warn(`[PROFILE] Direct JSON.parse failed. Falling back to LangChain parser: ${err.message}`);
        parsedResult = await parser.parse(cleanedResponse);
      }

      // Helper to parse nested array fields (experience, projects, education) which can be stringified JSON or native arrays
      const parseNestedArray = (val: any): any[] => {
        if (!val) return [];
        if (Array.isArray(val)) return val;
        if (typeof val === 'string') {
          try {
            const parsed = JSON.parse(val);
            if (Array.isArray(parsed)) return parsed;
          } catch (e) {
            // Ignore parse errors
          }
        }
        return [];
      };

      // Extract skills (can be array or comma-separated string)
      let coreSkills: string[] = [];
      if (parsedResult.coreSkills) {
        if (Array.isArray(parsedResult.coreSkills)) {
          coreSkills = parsedResult.coreSkills.map(s => String(s).trim()).filter(Boolean);
        } else {
          const rawSkills = String(parsedResult.coreSkills || '');
          coreSkills = rawSkills.split(',').map(s => s.trim()).filter(Boolean);
        }
      }

      const preferences = String(parsedResult.preferences || 'Remote');

      // Parse location preference
      let targetLocation = 'Remote';
      const segments = preferences.split(',').map(s => s.trim());
      const excludeKeywords = /remote|hybrid|onsite|on-site|office|startup|developer|engineer|no\b|roles\b|job\b|work\b/i;
      const locationSegment = segments.find(seg => !excludeKeywords.test(seg));

      if (locationSegment) {
        targetLocation = locationSegment;
      } else if (/remote/i.test(preferences)) {
        targetLocation = 'Remote';
      } else {
        targetLocation = 'India';
      }

      const isRemoteOpen = /remote/i.test(preferences);

      const profile: ParsedProfile = {
        fullName: String(parsedResult.fullName || ''),
        email: String(parsedResult.email || ''),
        phone: String(parsedResult.phone || ''),
        targetRole: String(parsedResult.targetRole || 'Backend Software Engineer'),
        coreSkills,
        experienceLevel: String(parsedResult.experienceLevel || 'Junior'),
        preferences,
        targetLocation,
        isRemoteOpen,
        experience: parseNestedArray(parsedResult.experience),
        projects: parseNestedArray(parsedResult.projects),
        education: parseNestedArray(parsedResult.education),
      };

      // Save to profile.json in the workspace root
      fs.writeFileSync(this.profileJsonPath, JSON.stringify(profile, null, 2), 'utf-8');
      this.logger.log(`[PROFILE] Successfully parsed and saved profile to ${this.profileJsonPath}`);
      return profile;
    } catch (e) {
      this.logger.error(`[PROFILE] LLM parsing/structuring failed: ${e.message}`);
      throw new Error(`Failed to structure parsed resume: ${e.message}`);
    }
  }

  // 2. Returns the current parsed profile (profile.json)
  getProfile(): ParsedProfile {
    if (fs.existsSync(this.profileJsonPath)) {
      try {
        const content = fs.readFileSync(this.profileJsonPath, 'utf-8');
        return JSON.parse(content) as ParsedProfile;
      } catch (e) {
        this.logger.error(`[PROFILE] Failed to read ${this.profileJsonPath}.`, e);
      }
    }

    // Default state when no resume has been uploaded yet
    return {
      fullName: 'No Resume Uploaded',
      email: '',
      phone: '',
      targetRole: 'Backend Software Engineer',
      coreSkills: [],
      experienceLevel: 'Junior',
      preferences: 'Remote',
      targetLocation: 'Remote',
      isRemoteOpen: true,
      experience: [],
      projects: [],
      education: [],
    };
  }

  // 3. Analyzes profile and returns a list of suggested job title search terms
  async suggestJobTitles(): Promise<string[]> {
    const profile = this.getProfile();
    this.logger.log(`[PROFILE] Generating search title suggestions for target role: "${profile.targetRole}"...`);

    const prompt = PromptTemplate.fromTemplate(`
      You are an elite career advisor. Based on the candidate's parsed profile below, suggest 4 to 6 specific, high-intent job title search terms to query job boards.
      Focus on terms that match their core skills and target role. Do NOT use overly broad terms like "Engineer".
      
      Candidate Profile:
      - Target Role: {targetRole}
      - Core Skills: {coreSkills}
      - Experience Level: {experienceLevel}
      
      Respond ONLY with a JSON array of strings containing the job titles.
      Do not include any conversational filler, markdown code blocks, or schema definitions. Just return the valid JSON array of strings.
      Example response format:
      ["Node.js Developer", "Backend Engineer", "Software Engineer"]
    `);

    const formattedPrompt = await prompt.format({
      targetRole: profile.targetRole,
      coreSkills: profile.coreSkills.length > 0 ? profile.coreSkills.join(', ') : 'None',
      experienceLevel: profile.experienceLevel,
    });

    try {
      const responseText = await this.invokeModelWithFallback(formattedPrompt);
      const cleanedResponse = this.cleanJsonText(responseText);
      
      const parsedResult = JSON.parse(cleanedResponse);
      if (Array.isArray(parsedResult)) {
        return parsedResult.map(t => String(t).trim()).filter(Boolean);
      } else if (parsedResult && typeof parsedResult === 'object' && Array.isArray(parsedResult.searchTerms)) {
        return parsedResult.searchTerms.map(t => String(t).trim()).filter(Boolean);
      } else if (parsedResult && typeof parsedResult === 'object' && typeof parsedResult.searchTerms === 'string') {
        return parsedResult.searchTerms.split(',').map(t => t.trim()).filter(Boolean);
      }
      
      throw new Error('Parsed result is not a JSON array');
    } catch (e) {
      this.logger.error(`[PROFILE] Failed to generate search title suggestions: ${e.message}`);
      return [profile.targetRole, 'Backend Developer', 'Software Engineer'];
    }
  }
}
