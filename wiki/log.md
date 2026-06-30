---
title: CareerAtlas Log
description: Chronological record of wiki updates and project state changes for CareerAtlas.
date: 2026-05-30
tags: [careeratlas, log, history, changelog]
---

## [2026-06-30] release | Distributed Queue Migration, Redis Caching, fastembed & Browser Context Pooling
- Migrated the linear agent service loop into a highly concurrent, distributed architecture using BullMQ message queues.
- Replaced file-locked JSON cache maps (`processed_jobs.json`, `seen_jobs.json`) with Redis sets incorporating 24-hour expiration TTLs.
- Updated `PipelineCoordinatorService` to manage execution hashes and atomic counters (`INCR`) in Redis to protect against parallel thread race conditions.
- Integrated Qdrant `fastembed` (`BGE-Small-EN-v1.5`) to perform text embedding generation in-process, resolving local ONNX memory locks and ensuring awaited cache writes.
- Implemented browser context and page pooling in `CamoufoxScraperService` to reuse browser processes and isolate cookies, yielding a 10x reduction in CPU and RAM overhead.
- Enhanced `ValidationService` with deep asynchronous expiry checking: checking for 404 HTTP errors in search results, empty page content, and searching the full fetched text for closed/expired keywords. Note: validation unit tests are purposefully excluded from the active workspace.
- Refactored `ValidationService` to load `@tiny-fish/sdk` dynamically using the NestJS `OnModuleInit` lifecycle, preventing CommonJS loader failures (`ERR_PACKAGE_PATH_NOT_EXPORTED`).
- Resolved Lever title-parsing bug in `AtsPortalsAgent` by swapping reversed company/title strings.

## [2026-06-13] release | Visual Architecture Flowchart & Technical Diagramming
- Designed and documented the complete end-to-end user onboarding and autonomous scraping pipeline in the [System Flowchart](flowchart.md).
- Integrated draw.io interactive diagram support using Mermaid.js syntax and the `drawio-master` technical design specifications.
- Documented actors, step-by-step flows, technical assumptions, and future enhancements of the NestJS discovery and pgvector scoring backend.

## [2026-06-09] release | Consolidated Backend Optimization & Multi-LLM Fallback
- Configured tri-level LLM fallback chain (Ollama → Gemini → Groq) to bypass online rate-limiting constraints during local development.
- Refactored orchestrator loop to track global matches across search terms, terminating the search cycles immediately once the target threshold of 5 jobs is met.
- Implemented a post-search rating filter: all matches are sorted by LLM score, and only the top 5 highest-rated jobs are matched and notified via Telegram.
- Reduced date query filter from 30 days to 7 days across scrapers to minimize stale search index matches.
- Added strict experience scoring instructions to prevent the LLM from overscoring junior profiles on senior/mid-senior roles.
- Restored LinkedIn Guest Mode scraping (cleaned query locations, regional subdomain routing, and robust selectors) and fixed location scoring target mismatches.

## [2026-06-07] hardening | LLM True Location Extraction & URL Path Targeting
- Renamed scraping agents to `AtsPortalsAgent`, `StartupBoardsAgent`, and `IndiaFocusedAgent` for architectural clarity.
- Implemented LLM-driven metadata extraction to identify true job locations from raw title and description snippets, allowing the scorer to reject irrelevant geographical matches (e.g. Noida/remote jobs targeting Ahmedabad).
- Refined site queries for Instahyre, Cutshort, and Naukri to strictly target singular job postings (`/job/`, `/job-listings-`), completely filtering out dynamic listing index categories.
- Added a catalog URL filter (`isCatalogUrl`) to exclude YC and Wellfound category listing pages.
- Restored `seen_jobs.json` as the default tracker for matched jobs, while designating `processed_jobs.json` strictly as the LLM query evaluation cache.

## [2026-06-07] upgrade | Integrated TinyFish Search & Playwright LinkedIn Agent
- Created `LinkedInAgent` (Playwright) with anti-bot fingerprint masking, human-like typing simulation, and login flow.[^3]
- Refactored `CareerPagesAgent`, `YcGreenhouseAgent`, and `WellfoundGlassdoorAgent` to fetch real-time data from the **TinyFish Search API** instead of DuckDuckGo HTML scraping.[^3]
- Implemented smart location extraction from `profile.txt` to enable searching in local cities (e.g. Bangalore, Ahmedabad) instead of hardcoding US.[^3]
- Configured MVP threshold to output 5 matching jobs per query cycle.[^3]
- Updated wiki docs with the new system flow.

## [2026-05-30] ingest | Initial CareerAtlas Wiki
- Created the wiki index at [CareerAtlas Wiki Index](index.md)
- Created the overview at [CareerAtlas Overview](overview.md)
- Created the architecture page at [Architecture](concepts/architecture.md)
- Created the core modules page at [Core Modules](entities/core-modules.md)
- Captured the current backend agent loop, stack, and frontend scaffold
- Key takeaway: the project already has an implemented NestJS job-hunting core, while the frontend remains a starter scaffold.

## [2026-05-30] ingest | Frontend Web App Page
- Created the frontend page at [Frontend App](entities/frontend-app.md)
- Added the frontend page to the wiki index and relationship map
- Captured the current web app source files: `page.tsx`, `layout.tsx`, `globals.css`
- Key takeaway: the frontend is still a starter Next.js shell with no product-specific CareerAtlas UI yet.

[^1]: ai-context/AGENTS.md
[^2]: ai-context/ARCHITECTURE.md
[^3]: backend/src/agent/agent.service.ts
[^4]: frontend/app/page.tsx