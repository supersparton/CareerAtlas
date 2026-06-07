import * as fs from 'fs';
import * as path from 'path';

export interface UserProfile {
  targetRole: string;
  coreSkills: string[];
  experienceLevel: string;
  preferences: string;
  targetLocation: string;
  isRemoteOpen: boolean;
}

export class ProfileParser {
  static parse(filePath: string): UserProfile {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Profile file not found at: ${filePath}`);
    }
    
    const content = fs.readFileSync(filePath, 'utf-8');
    
    const targetRoleMatch = content.match(/\[TARGET ROLE\]\r?\n([^\n]+)/i);
    const coreSkillsMatch = content.match(/\[CORE SKILLS\]\r?\n([^\n]+)/i);
    const experienceLevelMatch = content.match(/\[EXPERIENCE LEVEL\]\r?\n([^\n]+)/i);
    const preferencesMatch = content.match(/\[PREFERENCES\]\r?\n([^\n]+)/i);

    const targetRole = targetRoleMatch ? targetRoleMatch[1].trim() : 'Backend Software Engineer';
    const rawSkills = coreSkillsMatch ? coreSkillsMatch[1].trim() : '';
    const coreSkills = rawSkills.split(',').map(s => s.trim()).filter(Boolean);
    const experienceLevel = experienceLevelMatch ? experienceLevelMatch[1].trim() : 'Junior (0-2 years experience)';
    const preferences = preferencesMatch ? preferencesMatch[1].trim() : 'Remote';

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
      targetLocation = 'US';
    }

    const isRemoteOpen = /remote/i.test(preferences);

    return {
      targetRole,
      coreSkills,
      experienceLevel,
      preferences,
      targetLocation,
      isRemoteOpen,
    };
  }
}
