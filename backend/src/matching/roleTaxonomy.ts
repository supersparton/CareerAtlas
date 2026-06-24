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

  return role?.subfamily ?? null;
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