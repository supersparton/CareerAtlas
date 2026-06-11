You are a Senior Staff Engineer and AI Systems Architect.

Refactor the CareerAtlas job matching architecture into a production-grade recommendation system.

Do NOT implement a simple cosine similarity between a single user embedding and a single job embedding.

Instead implement a multi-stage ranking pipeline.

Business Goal

CareerAtlas fetches jobs from TinyFish API and recommends the most relevant jobs to a user.

A user uploads a resume.

The system extracts:

Skills
Experience
Education
Projects
Achievements

The user additionally provides preferences:

Preferred locations
Remote / Hybrid / Onsite
Employment type
Desired roles
Salary expectations (optional)

The system should rank jobs based on actual suitability rather than pure semantic similarity.

Existing Job Schema

Each job contains:

interface Job {
  id: string;
  title: string;
  company: string;
  url: string;
  description: string;
  location: string;
  postingDate: Date;
}
Existing Validation Layer

Before ranking:

Validate:

Duplicate jobs
Expired jobs
Broken URLs

Only validated jobs move forward.

New Architecture Requirements

Implement the following pipeline:

TinyFish Jobs
      |
      V
Validation Layer
      |
      V
Structured JD Extraction
      |
      V
Hard Filter Engine
      |
      V
Skill Match Engine
      |
      V
Embedding Match Engine
      |
      V
Weighted Ranking Engine
      |
      V
Top Ranked Jobs
Stage 1: Structured Profile Generation

Resume parser must output:

interface UserProfile {
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
Stage 2: Structured Job Extraction

Create a Job Intelligence service.

Extract from every Job Description:

interface JobRequirements {
  requiredSkills: string[];

  preferredSkills: string[];

  experienceRequired: number;

  educationRequirements: string[];

  employmentType: string;

  remoteAllowed: boolean;

  location: string;
}

Use an LLM or rule-based extractor.

Store extracted metadata.

Never repeatedly extract metadata for the same job.

Stage 3: Hard Filter Engine

Hard filters are mandatory.

Reject jobs that violate:

Location preference
Remote preference
Employment type
Minimum experience requirements
Salary expectations if available

Example:

1000 jobs
  |
  V
350 jobs

These jobs move to ranking.

Do NOT use embeddings for hard filters.

Stage 4: Skill Match Engine

Compute explicit skill overlap.

Example:

User:

Python
FastAPI
Docker
PostgreSQL

Job:

Python
Docker
AWS
TensorFlow

Score:

2 / 4 = 50%

Output:

interface SkillScore {
  overlapSkills: string[];
  missingSkills: string[];
  score: number;
}

Normalize skill aliases.

Examples:

NestJS -> Node.js
Express -> Node.js
FastAPI -> Python
Django -> Python

Create a skill normalization layer.

Stage 5: Embedding Match Engine

IMPORTANT:

Do NOT combine user preferences and user skills into one embedding.

Create separate semantic representation.

User embedding should contain:

Projects
Experience
Achievements
Education

Job embedding should contain:

Full Job Description

Generate embeddings only once.

Store embeddings permanently.

Never recompute existing embeddings.

Embedding Model

Use:

BAAI/bge-base-en-v1.5

Reason:

768 dimensions
Good quality
Fast inference
Moderate storage requirements

Alternative:

BAAI/bge-small-en-v1.5

for lower-cost deployments.

Create an abstraction layer so the model can be swapped later.

Vector Storage

Use PostgreSQL + pgvector.

Create:

job_embeddings

table:

job_id
embedding
created_at

Create:

user_embeddings

table:

user_id
embedding
created_at

Job embeddings should be generated only once when jobs are ingested.

User embeddings should be regenerated only when the profile changes.

Stage 6: Embedding Similarity

Compute:

cosineSimilarity(
   userEmbedding,
   jobEmbedding
)

Output:

interface SemanticScore {
   score: number;
}
Stage 7: Experience Match Engine

Calculate:

interface ExperienceScore {
   requiredYears: number;
   candidateYears: number;
   score: number;
}

Examples:

Candidate 3 years.

Job requires 2 years.

High score.

Candidate 1 year.

Job requires 5 years.

Low score.

Stage 8: Education Match Engine

Compare:

educationRequirements

against

user.education

Output:

interface EducationScore {
   score: number;
}
Stage 9: Weighted Ranking Engine

Do NOT rank solely by cosine similarity.

Final score:

50% Skill Match
30% Semantic Match
15% Experience Match
5% Education Match

Formula:

finalScore =
  (skillScore * 0.50) +
  (semanticScore * 0.30) +
  (experienceScore * 0.15) +
  (educationScore * 0.05);

Return:

interface RankedJob {
   job: Job;
   finalScore: number;
   skillScore: number;
   semanticScore: number;
   experienceScore: number;
   educationScore: number;
}

Sort descending.

NestJS Module Structure

Create:

modules/
│
├── profile/
├── jobs/
├── validation/
├── intelligence/
├── embeddings/
├── vector-store/
├── matching/
├── ranking/
└── notifications/
Matching Service Responsibilities

Matching Service should:

Load validated jobs
Apply hard filters
Compute skill score
Compute embedding similarity
Compute experience score
Compute education score
Calculate weighted ranking
Return top N jobs
Performance Requirements

System should support:

100,000+ jobs
10,000+ users

Requirements:

Batch embeddings
Store vectors in pgvector
Avoid duplicate embeddings
Cache extracted job metadata
Cache user profiles
Parallelize scoring