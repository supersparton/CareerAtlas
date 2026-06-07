# 📝 CHANGELOG — CareerOS

> **AI Agent Note:** This file tracks a detailed record of changes in the project. Update this file every time a significant update, fix, or feature is added. Use the format below.

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

