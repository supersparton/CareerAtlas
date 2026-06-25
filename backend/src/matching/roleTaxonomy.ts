// roleTaxonomy.ts

export interface SkillOntology {
  family: string;
  subfamily: string;
  skills: string[];
}

export const ROLE_ONTOLOGY = {
  mobile: {
    android: [
      "android",
      "kotlin",
      "java",
      "jetpack compose",
      "android sdk",
      "room",
      "dagger",
      "hilt"
    ],

    ios: [
      "ios",
      "swift",
      "swiftui",
      "objective-c",
      "xcode"
    ],

    cross_platform: [
      "flutter",
      "dart",
      "react native",
      "expo",
      "ionic",
      "xamarin"
    ]
  },

  frontend: {
    react: [
      "react",
      "redux",
      "nextjs",
      "javascript",
      "typescript"
    ],

    angular: [
      "angular",
      "rxjs",
      "ngrx"
    ],

    vue: [
      "vue",
      "nuxt",
      "pinia"
    ]
  },

  backend: {
    java: [
      "java",
      "spring",
      "spring boot",
      "hibernate"
    ],

    node: [
      "node",
      "nodejs",
      "express",
      "nestjs"
    ],

    python: [
      "python",
      "django",
      "flask",
      "fastapi"
    ],

    golang: [
      "go",
      "golang"
    ],

    dotnet: [
      ".net",
      "dotnet",
      "c#",
      "asp.net"
    ]
  },

  data: {
    machine_learning: [
      "machine learning",
      "deep learning",
      "tensorflow",
      "pytorch",
      "computer vision",
      "nlp"
    ],

    data_science: [
      "data scientist",
      "statistics",
      "pandas",
      "numpy",
      "scikit-learn"
    ],

    data_engineering: [
      "data engineer",
      "spark",
      "hadoop",
      "airflow",
      "kafka"
    ]
  },

  devops: {
    cloud: [
      "aws",
      "azure",
      "gcp"
    ],

    infrastructure: [
      "docker",
      "kubernetes",
      "terraform",
      "jenkins",
      "ansible",
      "ci/cd"
    ]
  },

  security: {
    cybersecurity: [
      "cybersecurity",
      "soc",
      "siem",
      "infosec"
    ],

    offensive: [
      "penetration testing",
      "pentest",
      "red team",
      "ethical hacking"
    ]
  },

  qa: {
    automation: [
      "selenium",
      "cypress",
      "playwright",
      "sdet"
    ],

    manual: [
      "manual testing",
      "qa",
      "quality assurance"
    ]
  }
} as const;

export const GENERIC_SOFTWARE_TITLES = [
  "software engineer",
  "software developer",
  "sde",
  "member of technical staff",
  "mts",
  "application engineer",
  "product engineer"
];

export const ROLE_ALIASES: Record<string, string[]> = {
  'software': [
    'software engineer',
    'software developer',
    'sde',
    'sde i',
    'sde-ii',
    'sde-2',
    'sde-1',
    'sde-3',
    'sde iii',
    'senior software engineer',
    'junior software engineer',
    'application engineer',
    'member of technical staff',
    'mts',
    'technical staff member',
    'software development engineer',
    'fullstack engineer',
    'full stack developer',
    'full-stack developer',
    'full stack engineer',
    'fullstack developer',
    'full-stack engineer'
  ],
  'backend': [
    'backend engineer',
    'backend developer',
    'node.js developer',
    'node developer',
    'python backend developer',
    'python developer',
    'java developer',
    'java backend developer',
    'golang developer',
    'golang backend developer',
    'go developer',
    'c# developer',
    'dot net developer',
    '.net developer',
    'backend software engineer'
  ],
  'frontend': [
    'frontend engineer',
    'frontend developer',
    'front-end developer',
    'front end developer',
    'react developer',
    'react.js developer',
    'vue developer',
    'angular developer',
    'ui engineer',
    'ui developer',
    'frontend software engineer'
  ],
  'data': [
    'data analyst',
    'business analyst',
    'analytics engineer',
    'product analyst',
    'data analytics',
    'data engineer',
    'data platform engineer',
    'big data engineer',
    'data scientist',
    'machine learning engineer',
    'ml engineer',
    'ai engineer',
    'applied scientist'
  ],
  'devops': [
    'devops engineer',
    'site reliability engineer',
    'sre',
    'platform engineer',
    'cloud engineer',
    'systems engineer'
  ],
  'product': [
    'product manager',
    'pm',
    'associate product manager',
    'technical product manager'
  ]
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function cleanTitleForTaxonomy(title: string): string {
  if (!title) return "";

  let cleaned = title;

  cleaned = cleaned.replace(/\s+@\s+.+$/i, "");
  cleaned = cleaned.replace(/\s+\bat\b\s+.+$/i, "");
  cleaned = cleaned.replace(/\(YC\s+\w+\)/i, "");

  return cleaned.trim();
}

export function detectRole(
  text: string
): SkillOntology | null {

  if (!text) return null;

  const normalized = text.toLowerCase();

  for (const [family, subfamilies] of Object.entries(ROLE_ONTOLOGY)) {

    for (const [subfamily, skills] of Object.entries(subfamilies)) {

      for (const skill of skills) {

        const regex = new RegExp(
          `\\b${escapeRegExp(skill.toLowerCase())}\\b`,
          "i"
        );

        if (regex.test(normalized)) {
          return {
            family,
            subfamily,
            skills
          };
        }
      }
    }
  }

  return null;
}

export function detectFamily(text: string): string | null {
  const role = detectRole(text);
  if (role) {
    return role.family;
  }

  const title = cleanTitleForTaxonomy(text).toLowerCase();

  // 1. Check role aliases map
  for (const [family, aliases] of Object.entries(ROLE_ALIASES)) {
    for (const alias of aliases) {
      const regex = new RegExp(`\\b${escapeRegExp(alias.toLowerCase())}\\b`, "i");
      if (regex.test(title)) {
        return family;
      }
    }
  }

  // 2. Fallback to generic software titles
  for (const generic of GENERIC_SOFTWARE_TITLES) {
    if (title.includes(generic.toLowerCase())) {
      return "software";
    }
  }

  return null;
}

export function detectSubfamily(
  text: string
): string | null {
  const role = detectRole(text);
  if (role) {
    return role.subfamily;
  }

  const title = cleanTitleForTaxonomy(text).toLowerCase();

  // Custom checks for subfamilies based on keywords in title
  if (title.includes('android') || title.includes('kotlin')) return 'android';
  if (title.includes('ios') || title.includes('swift')) return 'ios';
  if (title.includes('flutter') || title.includes('react native') || title.includes('react-native')) return 'cross_platform';
  
  if (title.includes('react') || title.includes('nextjs') || title.includes('next.js')) return 'react';
  if (title.includes('angular')) return 'angular';
  if (title.includes('vue') || title.includes('nuxt')) return 'vue';
  
  if (title.includes('node') || title.includes('nestjs') || title.includes('express')) return 'node';
  if (title.includes('python') || title.includes('django') || title.includes('fastapi')) return 'python';
  if (title.includes('java') || title.includes('spring')) return 'java';
  if (title.includes('golang') || title.includes('go developer')) return 'golang';
  if (title.includes('c#') || title.includes('.net') || title.includes('dotnet')) return 'dotnet';
  
  if (title.includes('machine learning') || title.includes('ml ') || title.includes('ai ') || title.includes('deep learning')) return 'machine_learning';
  if (title.includes('data engineer') || title.includes('big data')) return 'data_engineering';
  if (title.includes('data analyst') || title.includes('business analyst') || title.includes('statistician')) return 'data_science';
  
  if (title.includes('cloud') || title.includes('aws') || title.includes('azure') || title.includes('gcp')) return 'cloud';
  if (title.includes('devops') || title.includes('sre') || title.includes('site reliability') || title.includes('infrastructure')) return 'infrastructure';

  return null;
}

export function getMatchedSkills(
  text: string
): string[] {

  const normalized = text.toLowerCase();

  const matched = new Set<string>();

  for (const subfamilies of Object.values(ROLE_ONTOLOGY)) {

    for (const skills of Object.values(subfamilies)) {

      for (const skill of skills) {

        const regex = new RegExp(
          `\\b${escapeRegExp(skill.toLowerCase())}\\b`,
          "i"
        );

        if (regex.test(normalized)) {
          matched.add(skill);
        }
      }
    }
  }

  return [...matched];
}

export function calculateFamilySimilarity(
  familyA: string | null,
  familyB: string | null
): number {

  if (!familyA || !familyB) return 0;

  if (familyA === familyB) {
    return 1;
  }

  if (
    familyA === "software" ||
    familyB === "software"
  ) {
    return 0.5;
  }

  return 0;
}

export function calculateSubfamilySimilarity(
  familyA: string | null,
  subA: string | null,
  familyB: string | null,
  subB: string | null
): number {

  if (!familyA || !familyB) {
    return 0;
  }

  if (familyA !== familyB) {
    return 0;
  }

  if (subA === subB) {
    return 1;
  }

  return 0.3;
}