---
title: CareerAtlas Core Modules
description: Code-level summary of the main backend services and their responsibilities in the CareerAtlas job-hunting workflow.
date: 2026-06-30
tags: [careeratlas, modules, backend, services, agent, queues]
---

The CareerAtlas backend is built as a highly decoupled, queue-driven NestJS architecture using **BullMQ**, **Redis**, **PostgreSQL**, and **Qdrant** to orchestrate job discovery, validation, scraping, analysis, embedding, and matching.

## Service Responsibilities

| Service / Agent / Worker | Responsibility | Key Methods / Behavior |
| --- | --- | --- |
| **AgentController** | Exposes endpoints for resume upload, suggestions, and running the agent. | `uploadResume()`, `getProfile()`, `suggestTitles()`, `runAgent()` |
| **ProfileService** | Parses PDF resume using LLM, saves it to `profile.json`, and recommends search titles. | `parseResumePdf()`, `getProfile()`, `suggestJobTitles()` |
| **AgentService** | Syncs user preferences and triggers the BullMQ discovery runs. | `runAgent()`, `runWorkflowSuite()` |
| **PipelineCoordinatorService** | Synchronizes steps, logs, and job counters in Redis to manage run states across distributed workers. | `startRun()`, `updateStep()`, `addLog()`, `decrementRemainingJobs()` |
| **DiscoveryWorker** | Parallelizes queries across discovery agents and enqueues raw jobs for validation. | `atsPortalsAgent`, `startupBoardsAgent`, `indiaFocusedAgent`, `linkedinAgent` |
| **ValidationService** | Performs duplicate checks, location validation, and deep async expiry checks (detecting 404s, empty pages, and closed keywords via dynamic TinyFish imports). *Note: Testing scripts have been purposefully excluded.* | `validateSingleJob()`, `isExpired()`, `isUrlActive()`, `isJobInUserResults()` |
| **ValidationWorker** | Pulls from the `job-validation` queue, executes `ValidationService` checks, and forwards valid jobs. | `process()` |
| **ScrapingWorker** | Uses anti-detect scrapers to extract full job descriptions and enqueues requirements extraction. | `process()` |
| **CamoufoxScraperService** | anti-detect browser scraper implementing browser session pooling and context isolation for minimal CPU overhead. | `scrapeUrl()`, `getBrowser()`, `onModuleDestroy()` |
| **IntelligenceWorker** | Pulls from `job-intelligence` and invokes requirements extraction. | `process()` |
| **JobIntelligenceService** | Extracts critical, required, and preferred skills, location, remote status, and experience level using LLM provider chains. | `extractRequirements()` |
| **EmbeddingWorker** | Generates embeddings in-process and writes vector payloads. | `process()` |
| **EmbeddingsService** | Generates high-efficiency embeddings locally using Qdrant `fastembed` (`BGE-Small-EN-v1.5`), ensuring all cache writes are awaited. | `generateEmbedding()`, `onModuleInit()` |
| **MatchingWorker** | Pulls from `job-matching`, checks requirements, rates matches, and triggers notifications. | `process()` |
| **MatchingService** | Scores candidate jobs using a flattened $O(1)$ constant-time `SKILL_INDEX` taxonomy, generates personal LLM match rationales, and alerts. | `matchAndRankJobs()`, `scoreJob()` |
| **MemoryService** | Deduplicates jobs using SHA-256 hashes stored in Redis sets with 24-hour expiration TTLs. | `isJobMatched()`, `isJobProcessed()`, `markJobAsMatched()`, `markJobAsProcessed()`, `generateJobHash()` |
| **NotifierService** | Sends Telegram alerts for high-value job matches. | `sendJobAlert()` |

## Pipeline Dependency Flow

The system uses BullMQ queues to coordinate asynchronous tasks across isolated workers, synchronized via Redis and the `PipelineCoordinatorService`:

```mermaid
sequenceDiagram
    autonumber
    actor User as Candidate
    participant Agent as AgentService
    participant Discovery as DiscoveryWorker
    participant Validation as ValidationWorker
    participant Scraping as ScrapingWorker
    participant IntelWorker as IntelligenceWorker
    participant EmbedWorker as EmbeddingWorker
    participant Matching as MatchingWorker
    participant Coordinator as PipelineCoordinatorService

    User->>Agent: POST /api/agent/run (Trigger Search)
    Note over Agent: Sync preferences & user embedding
    Agent->>Discovery: Enqueue 'discover-jobs' task
    
    rect rgb(230, 242, 255)
        Note over Discovery: Phase 1: Search & Scrape
        Discovery->>Discovery: Run 4 scrapers in parallel
        Discovery-->>Discovery: Consolidate raw job list
        Discovery->>Validation: Enqueue 'validate-job' task (For each raw job)
    end

    rect rgb(240, 248, 240)
        Note over Validation: Phase 2: Screen & Validate
        Validation->>Validation: Run dedupe, location & HEAD checks
        Validation->>Validation: Run deep expiry checks (404/expired keywords)
        alt Job is duplicate / invalid / expired
            Validation->>Coordinator: Decrement remaining jobs (atomic Redis INCR)
        else Job is valid
            Validation->>Scraping: Enqueue 'scrape-job' task
        end
    end

    rect rgb(255, 245, 230)
        Note over Scraping: Phase 3: Extract & Analyze
        Scraping->>Scraping: Scrape full text (Camoufox browser pooling)
        Scraping->>IntelWorker: Enqueue 'extract-requirements' task
    end

    rect rgb(245, 235, 255)
        Note over IntelWorker: Phase 4: Requirements & Embedding
        IntelWorker->>IntelWorker: Parse skills/experience via LLM
        IntelWorker->>EmbedWorker: Enqueue 'embed-job' task
        EmbedWorker->>EmbedWorker: Generate vector embedding (fastembed)
        EmbedWorker-->>EmbedWorker: Upsert to Qdrant index
        EmbedWorker->>Matching: Enqueue 'match-job' task
    end

    rect rgb(255, 235, 235)
        Note over Matching: Phase 5: Score & Notify
        Matching->>Matching: Run O(1) matching engine & filters
        alt Job matches user criteria (score >= 60)
            Matching->>Matching: Write matching details to PostgreSQL results
            Matching->>Matching: Send Telegram notification
        end
        Matching->>Coordinator: Decrement remaining jobs (atomic Redis INCR)
    end
```

## What Each Module Depends On

- **`MemoryService` & `PipelineCoordinatorService`** depend on **Redis** (`ioredis` client) for lightning-fast, atomic deduplication and pipeline state tracking.
- **`EmbeddingsService`** depends on **Qdrant `fastembed`** (`@xenova/transformers` was replaced) to perform in-process, high-efficiency local embedding generation.
- **`ValidationService`** depends on `@tiny-fish/sdk` (loaded dynamically via dynamic `import()` to bypass CommonJS packaging restrictions at runtime) to fetch and inspect job postings for 404 errors, empty content, or closed keywords.
- **`CamoufoxScraperService`** depends on Playwright Firefox (`camoufox`) and implements browser session pooling (`isConnected()` checks) and page context recycling to eliminate CPU-heavy browser initialization overhead.
- **`JobIntelligenceService`** depends on Groq, Gemini, or local Ollama LLMs to parse and structure unstructured job descriptions into typed JSON schemas.
- **`NotifierService`** depends on the Telegram Bot API.

## Operational Notes

- **Cache TTLs**: Deduplication hashes in Redis expire after 24 hours to ensure stale job metadata is cleaned up.
- **Atomic Concurrency**: Job progress counts are decremented using Redis `INCR` operations rather than read-modify-write calls, protecting against race conditions during highly parallel workers.
- **Lever Title Logic**: Job titles scraped from `lever.co` are automatically parsed to separate `company` and `title` fields, preventing downstream taxonomy categorization failures.
- **Unit Testing**: To prevent code clutter, active unit testing scripts for validation are purposefully excluded from the active workspace repository.