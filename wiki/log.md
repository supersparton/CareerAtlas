---
title: CareerAtlas Log
description: Chronological record of wiki updates and project state changes for CareerAtlas.
date: 2026-05-30
tags: [careeratlas, log, history, changelog]
---

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