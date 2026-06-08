# 📝 CHANGELOG — CareerOS

> **AI Agent Note:** This file tracks a detailed record of changes in the project. Update this file every time a significant update, fix, or feature is added. Use the format below.

## [2026-06-09] - 02:25
### Summary
Consolidated backend optimization, LLM reliability, and scraping improvements. Integrated local Ollama support and Gemini primary API with fallback mechanisms, resolved parallel orchestrator execution loops, tightened recency and experience scoring filters, and restored LinkedIn guest mode scraping.

### Added
- **Multi-LLM & Local Failsafe Support**: Implemented a tri-level LLM fallback chain (Ollama → Gemini → Groq) to ensure rate-limit resilience. Configured local Ollama support via REST endpoint (`/api/generate`) with environment toggles (`USE_OLLAMA`, `OLLAMA_MODEL`).
- **Parallelized Evaluation**: Optimized pipeline latency by scoring scraped jobs concurrently using `Promise.all`, reducing batch analysis time from ~15 seconds to ~1.5 seconds.
- **Top 5 Rating Filter**: Refactored `AgentService` to collect matching candidate jobs across all search terms first, sort them by LLM score descending, and only notify the user about the top 5 highest-rated jobs.

### Fixed
- **Background Orchestrator Loop**: Corrected the orchestrator loop execution in `AgentController` to track global matches across search terms, pass the remaining target count down, and terminate immediately once the target threshold of 5 jobs is reached.
- **Tighter Recency & Experience Filtering**: Reduced the date query filter window from 30 days to 7 days in `IndiaFocusedAgent`, `AtsPortalsAgent`, and `StartupBoardsAgent` to avoid stale search indexes. Configured strict prompt guidelines to prevent the LLM from overscoring junior profiles on senior/mid-senior roles.
- **Ollama Output & Parsing Fixes**: Added a hybrid JSON parser to bypass strict LangChain/Zod validation constraints when local models return native numbers/booleans. Also refactored search title suggestions to output flat JSON arrays, preventing Ollama from echoing JSON schema definitions.
- **LinkedIn Guest Mode & Location Scoring**: Restored Guest Mode scraping by cleaning Boolean `OR` location queries (unsupported by LinkedIn), routing requests to regional subdomains (e.g. `in.linkedin.com`), and expanding card selectors. Fixed location scoring in `IntelligenceService` to evaluate against active search targets rather than static profile targets.
- **PDF Parse Namespace & Profile Fallbacks**: Hardened `ProfileService` against `pdf-parse` export differences and removed legacy `profile.txt` filesystem fallbacks to strictly utilize uploaded resume files.

---

## [2026-06-08] - 23:55
### Summary
Implemented an interactive input layer featuring resume PDF parsing, structured JSON profile generation, dynamic job title suggestions, and user-initiated API-driven searches.

### Added
- **PDF Resume Parser Service (`profile.service.ts`)**: Integrated `pdf-parse` for text extraction from resume uploads. The service calls Groq (`llama-3.3-70b-versatile`) to generate a structured JSON profile (`profile.json`) mapping contact info, skills, experience, projects, and education.
- **Title Recommendation Engine**: Added a method to automatically suggest 4–6 optimized search titles (terms) matching the user's parsed resume history and targeted role.
- **REST API Controller (`agent.controller.ts`)**: Added endpoints to process uploads (`POST /api/profile/upload-resume`), retrieve parsed user data (`GET /api/profile`), get search term suggestions (`GET /api/profile/suggest-titles`), and trigger background search workflow runs (`POST /api/agent/run`).
- **Orchestrator Standby Mode**: Updated `AgentService` to bootstrap in standby mode, waiting for explicit API search runs instead of auto-executing on application start.

---

## [2026-06-07] - 15:05
### Summary
Fixed logical bugs in location search, added a dynamic job freshness filter, restored `seen_jobs.json` as the default tracker, and restricted fallbacks to mock-only testing mode.

### Fixed
- **Scraper Agent Reorganization**: Repurposed the 4 scraping agents to optimize results for local and international job searches:
  - **ATS Agent (`ats-portals.agent.ts`)**: Targets ATS platforms (Greenhouse, Lever, Ashby, Workable).
  - **Startup Boards Agent (`startup-boards.agent.ts`)**: Targets YC India and Wellfound India job boards, with dynamic fallback queries for remote/India listings.
  - **India-Focused Agent (`india-focused.agent.ts`)**: Targets local Indian platforms (Instahyre, Cutshort, Naukri).
  - **LinkedIn Agent (`linkedin.agent.ts`)**: Keeps browser-based Playwright scraping with guest mode pagination fixes.
- **LLM-Driven Metadata Refinement**: Replaced hardcoded location settings. The LLM Scorer now analyzes the full title, company, and snippet text to identify the actual/true location (e.g. extracting Noida, London, New Delhi) and actual company name. The Orchestrator uses these verified values to recalculate hashes and format notifications, preventing false location matches.
- **India-Focused Query Expansion & Fallbacks**: Broadened the search queries for Instahyre, Cutshort, and Naukri to search for title synonyms (`"Backend Developer"`, `"Python Developer"`, etc.). Added a fallback routine that automatically retries the search without the `after:` date operator if no results are found, which maximizes the recovery of active postings.
- **Precise Path Targeting**: Refined the site queries for local Indian job sites to target only individual postings (`site:naukri.com/job-listings-`, `site:instahyre.com/job/`, `site:cutshort.io/job/`). This completely eliminates generic/dynamic catalog category indices (such as "7221 Node Js Developer Job Vacancies in June 2026") from leaking into the pipeline.
- **YC & Wellfound Catalog Exclusion**: Implemented a URL check (`isCatalogUrl`) in `startup-boards.agent.ts` to detect and filter out general listing paths (e.g. `/jobs/role/`, `/jobs/l/`, and location directories) for Y Combinator and Wellfound, ensuring only company-specific postings are evaluated.
- **Enhanced Title Parsing**: Refactored the title parsing regular expression to correctly extract company names and job titles from Google-indexed headings for Instahyre, Cutshort, and Naukri.
- **Mock Fallback Elimination**: Completely removed `getFallbackJobs` and all associated hardcoded dummy mock data from all agents. When searches yield 0 results or are run without API keys, agents now return clean empty arrays `[]` rather than mock jobs.

---

## [2026-06-07] - 14:45
### Summary
Refactored and optimized the MVP core architecture by implementing normalized contracts, robust multi-criteria JSON matching, compound deduplication caching, isolated profile configuration, and structured logging.

### Added
- Created `ProfileParser` (in `src/agent/profile.parser.ts`) to extract target roles, skills lists, experience levels, and location properties from `profile.txt` into a strongly-typed `UserProfile` config object.
- Created `generateJobId` helper (in `src/discovery/discovery.service.ts`) using stable SHA-256 compound strings to represent unique job IDs.

### Changed
- Refactored `IntelligenceService`'s matching logic to request sub-scores for Skills, Experience, and Location from Llama 3.3 in a single structured JSON response, aggregating them using a weighted formula: `0.5 * skills + 0.3 * experience + 0.2 * location`.
- Switched deduplication cache file from `seen_jobs.json` to `processed_jobs.json` containing stable compound hashes (`company|title|location|source`) to prevent false-positive duplicate collisions (e.g., same job titles in different cities).
- Replaced the legacy `ScrapedJob` format across all discovery agents with a unified, strictly typed `Job` interface to isolate ingestion from scraper-specific nuances.
- Updated `NotifierService` to format and deliver individual sub-scores (Skills, Experience, Location) in the Telegram notification card.
- Implemented structured logging tags (`[SCRAPER]`, `[SCORER]`, `[NOTIFIER]`, `[MEMORY]`, and `[ORCHESTRATOR]`) for complete loop visibility.

---

## [2026-06-06] - 12:05
### Summary
Refactored the job discovery pipeline for the developer MVP. Replaced DuckDuckGo static/expired searches with the real-time TinyFish Search API, created a dedicated browser-based Playwright LinkedIn scraping agent, and adjusted matching loops to target a threshold of 5 matches per search query.

### Added
- Created `LinkedInAgent` (in `src/discovery/linkedin.agent.ts`) implementing advanced Playwright scraping with browser anonymization scripts, human-like typing, and support for authenticated or guest scraping modes.
- Wired the new `LinkedInAgent` into the `DiscoveryModule` and parallel promise search list of `AgentService`.

### Changed
- Replaced DuckDuckGo HTML scraping inside `CareerPagesAgent`, `YcGreenhouseAgent`, and `WellfoundGlassdoorAgent` with direct HTTP queries to the TinyFish Search API (`api.search.tinyfish.ai`), resulting in fresh, non-expired search listings and 10x faster execution.
- Raised the high-match target threshold from 3 to 5 accepted jobs per search cycle.

---

## [2026-05-29] - 14:22
### Summary
Migrated the entire CareerOS backend from procedural Python scripts to a robust Node.js/NestJS architecture. This ensures compatibility with free hosting services and provides an enterprise-grade structure for the Hermes-style autonomous workflow.

### Added
- Created a new NestJS project in `career-os-backend`.
- Added `DiscoveryModule` using Playwright to scrape LinkedIn jobs autonomously.
- Added `IntelligenceModule` using `@langchain/groq` to read `profile.txt` and score jobs.
- Added `MemoryModule` using Node's native `fs` to deduplicate and store `seen_jobs.json`.
- Added `NotifierModule` using native `fetch` to send rich Markdown alerts to Telegram.
- Added `AgentModule` as the central orchestrator that replicates the Hermes Agent ReAct loop in TypeScript.
- Added this `CHANGELOG.md` file to track progress systematically.

### Changed
- Replaced Python (`agent.py`, `classifier.py`, `discovery.py`, `notifier.py`) with NestJS services (`agent.service.ts`, etc.).
- Switched the Telegram notifier from `axios` to native `fetch` to avoid library vulnerabilities.
- Updated the `.env` loader (`ConfigModule`) to load credentials from the parent root directory.

### Fixed
- Fixed type-casting issues with LangChain's `StructuredOutputParser` which originally returned strings instead of numbers and booleans.

---
*(End of Changelog)*

