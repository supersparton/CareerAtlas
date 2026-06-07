---
title: CareerAtlas Overview
description: High-level summary of CareerAtlas, its current implementation status, and the main source files that define the project.
date: 2026-05-30
tags: [careeratlas, overview, project-status, backend, frontend]
---

CareerAtlas, also called CareerOS in the project context, is an autonomous AI job-hunting system built around a NestJS backend that scrapes jobs, deduplicates them, scores them against a user profile, and sends Telegram alerts for strong matches.[^1][^2] The live codebase currently reflects the NestJS migration described in the context docs, while the frontend remains a starter scaffold.[^3][^4][^5]

## Scope

The backend is the active execution layer. `AgentService` orchestrates the workflow. The `DiscoveryModule` runs 4 discovery agents in parallel: `LinkedInAgent` scrapes LinkedIn directly using Playwright browser automation with anti-bot fingerprint masking, while `CareerPagesAgent`, `YcGreenhouseAgent`, and `WellfoundGlassdoorAgent` scrape Lever/Ashby/Workable, Greenhouse/YC, and Wellfound/Glassdoor via direct queries to the **TinyFish Search API** (`api.search.tinyfish.ai`). `IntelligenceService` scores candidate jobs using Groq (Llama 3.3) via LangChain.js, `MemoryService` tracks seen jobs via SHA-256 hashes, and `NotifierService` sends notifications via Telegram.[^6][^7][^8][^9][^10]

The frontend exists as a separate Next.js app, but its current page, layout, and CSS are still default create-next-app content rather than a product surface.[^11][^12][^13]

## Current Status

| Area | Status | Evidence |
| --- | --- | --- |
| Backend agent loop | Implemented | `AgentService` runs parallel scrape -> dedupe -> score -> alert.[^6] |
| Discovery Agents | Upgraded | LinkedIn uses stealth Playwright; Lever/Greenhouse/Wellfound use TinyFish Search API for real-time listings. |
| Target Threshold | Upgraded | The MVP target has been increased to 5 matching jobs per query session.[^6] |
| Location Targeting | Implemented | Smart parser extracts local cities (e.g. Ahmedabad, Bangalore) from `profile.txt` preferences segment.[^6] |
| Model scoring | Implemented | `ChatGroq` uses `llama-3.3-70b-versatile` with zero temperature.[^8] |
| Deduplication | Implemented | `seen_jobs.json` is a flat hash store keyed by title and company.[^9] |
| Telegram alerts | Implemented | Alerting uses native `fetch` against the Telegram Bot API.[^10] |
| Frontend product UI | Not yet built | `frontend/app/page.tsx` is the default starter page.[^11] |
| Frontend source files | Scaffolding only | `page.tsx`, `layout.tsx`, and `globals.css` are still starter files.[^11][^12][^13] |
| Project documentation | Centralized in ai-context | `ai-context/` holds the current operating docs and roadmap.[^1][^2][^3][^4] |

## Key Findings

- The project is organized around one autonomous workflow rather than a manual job board browsing app.[^1][^2]
- DuckDuckGo / general search engine indexed page crawls return expired/stale job links. Transitioning to direct API calls via TinyFish Search API yields live, active jobs and speeds up searches by 10x.
- Anti-fingerprint masking (blocking WebGL/Canvas, overriding `navigator.webdriver`) is required to prevent LinkedIn checkpoints.
- `profile.txt` remains the user-editable target input containing location preferences and skills.[^8]

## Runtime Overview

```mermaid
flowchart TD
    A["Job Boards (LinkedIn, Greenhouse, Wellfound, Lever)"] --> B["Discovery Agent Network (Playwright & TinyFish)"]
    B --> C["MemoryService Deduplication (seen_jobs.json)"]
    C --> D["IntelligenceService Scoring (Groq LLM)"]
    D --> E["NotifierService (Telegram Alert)"]
```

[^1]: ai-context/AGENTS.md
[^2]: ai-context/ARCHITECTURE.md
[^3]: ai-context/PROGRESS.md
[^4]: ai-context/RULES.md
[^5]: backend/package.json
[^6]: backend/src/agent/agent.service.ts
[^7]: backend/src/discovery/discovery.module.ts
[^8]: backend/src/intelligence/intelligence.service.ts
[^9]: backend/src/memory/memory.service.ts
[^10]: backend/src/notifier/notifier.service.ts
[^11]: frontend/app/page.tsx
[^12]: frontend/app/layout.tsx
[^13]: frontend/app/globals.css