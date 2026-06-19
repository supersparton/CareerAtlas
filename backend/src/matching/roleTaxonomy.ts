export const ROLE_TAXONOMY: { [key: string]: string[] } = {
  // Specialized families first
  mobile: ["mobile", "android", "ios", "flutter", "react native", "xamarin", "swift", "kotlin"],
  backend: ["backend", "java", "spring", "node", "golang", "dotnet", "django", "flask", "python developer", "ruby on rails", "ror", "expressjs", "c++", "c#"],
  frontend: ["frontend", "react", "angular", "vue", "nextjs", "nuxt", "svelte", "javascript", "typescript", "html", "css", "web developer", "ui engineer"],
  fullstack: ["fullstack", "full stack", "mern", "mean", "jamstack"],
  devops: ["devops", "sre", "kubernetes", "docker", "platform", "cloud", "aws", "gcp", "azure", "terraform", "ci/cd", "jenkins"],
  data: ["data engineer", "machine learning", "ml", "ai", "nlp", "computer vision", "deep learning", "data scientist", "data analyst", "analytics engineer", "spark", "hadoop", "tensorflow", "pytorch"],
  security: ["security", "soc", "cybersecurity", "pentest", "penetration", "appsec", "infosec", "cryptography"],
  qa: ["qa", "quality assurance", "testing", "selenium", "cypress", "automation engineer", "sdet"],
  product: ["product manager", "pm", "apm", "tpm", "product owner"],
  design: ["product designer", "ui/ux", "ux designer", "ui designer", "graphic designer", "figma"],
  
  // General/Fallback software family last
  software: ["software engineer", "software developer", "sde", "application engineer", "member of technical staff", "mts"]
};

export const FAMILY_HIERARCHY: { [key: string]: string[] } = {
  software: [
    "mobile",
    "backend",
    "frontend",
    "fullstack",
    "devops",
    "data",
    "security",
    "qa"
  ]
};

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function cleanTitleForTaxonomy(title: string): string {
  if (!title) return "";
  // Remove " @ Company" or " at Company"
  let cleaned = title.replace(/\s+@\s+.+$/i, "");
  cleaned = cleaned.replace(/\s+\bat\b\s+.+$/i, "");
  cleaned = cleaned.replace(/\(YC\s+\w+\)/i, "");
  return cleaned.trim();
}

export function detectFamily(title: string): string | null {
  if (!title) return null;
  const cleanedTitle = cleanTitleForTaxonomy(title);
  const titleLower = cleanedTitle.toLowerCase().trim();

  for (const [family, keywords] of Object.entries(ROLE_TAXONOMY)) {
    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      // For short acronyms/terms like ml, ai, pm, qa, soc, use word boundary checks
      if (kwLower.length <= 3) {
        const regex = new RegExp(`\\b${escapeRegExp(kwLower)}\\b`, "i");
        if (regex.test(titleLower)) {
          return family;
        }
      } else {
        if (titleLower.includes(kwLower)) {
          return family;
        }
      }
    }
  }

  return null;
}

export function isAncestor(parent: string, child: string): boolean {
  if (!parent || !child) return false;
  
  const p = parent.toLowerCase();
  const c = child.toLowerCase();

  // Allow bidirectional matching for core web roles: backend, frontend, fullstack <-> software
  const coreRoles = ["backend", "frontend", "fullstack"];
  if (p === "software" && coreRoles.includes(c)) {
    return true;
  }
  if (c === "software" && coreRoles.includes(p)) {
    return true;
  }

  const children = FAMILY_HIERARCHY[p];
  if (children && children.includes(c)) {
    return true;
  }
  return false;
}
