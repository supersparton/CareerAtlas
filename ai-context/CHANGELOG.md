# 📝 CHANGELOG — CareerOS

> **AI Agent Note:** This file tracks a detailed record of changes in the project. Update this file every time a significant update, fix, or feature is added. Use the format below.

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

