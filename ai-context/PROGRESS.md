# 📈 PROGRESS — CareerOS V1 (Core Hunter)

> **AI Agent Note:** This is the canonical source of truth for project status. Update this file whenever a phase is completed or a key decision is made.

---

## 🗺️ 24-Week Roadmap Overview

| Version | Name | Duration | Status |
| :--- | :--- | :--- | :--- |
| **V1** | Core Hunter | Weeks 1–8 | 🚧 **In Progress** |
| **V2** | Smart Engine | Weeks 9–18 | 🔲 Not Started |
| **V3** | Platform | Weeks 19–24 | 🔲 Not Started |

---

## ✅ V1 — Core Hunter: Phase-by-Phase Status

### Phase 1: Foundation Setup ✅ COMPLETE
- [x] Created `.env` with all required API keys (Groq, TinyFish, Telegram).
- [x] Created `.env.example` template for safe git commits.
- [x] Created `.gitignore` (ignores `.env`, `__pycache__`).
- [x] Created `requirements.txt` (`python-dotenv`, `requests`, `hermes-agent`).
- [x] Created `test_keys.py` — verifies Groq and Telegram API connectivity.
- [x] Confirmed Groq and Telegram connections are live.

**Key Learnings from Phase 1:**
- `llama3-8b-8192` was decommissioned by Groq. Use `llama-3.3-70b-versatile`.
- TinyFish requires `X-API-Key` header (not `Authorization: Bearer`).
- TinyFish requires a `{"urls": [url]}` payload (not `{"url": url}`).

---

### Phase 2: Job Discovery & Deduplication ✅ COMPLETE
- [x] Created `discovery.py` with `fetch_page_with_tinyfish()` and `extract_jobs_with_llm()`.
- [x] Confirmed TinyFish scrapes `https://news.ycombinator.com/jobs` successfully.
- [x] LLM extracts clean structured job JSON (`title`, `location`, `url`, `requirements`).
- [x] Created `generate_job_hash()`, `load_seen_jobs()`, `save_seen_jobs()` for deduplication.
- [x] Agent memory (`seen_jobs.json`) correctly stores 27 job fingerprints.
- [x] Confirmed deduplication works: second run correctly skips all 27 seen jobs.

**Key Learnings from Phase 2:**
- AshbyHQ (`jobs.ashbyhq.com`) returns "You need to enable JavaScript" — blocked by anti-bot protection.
- `boards.greenhouse.io/databricks` redirected to the corporate homepage — no jobs in scraped text.
- Hacker News jobs page (`news.ycombinator.com/jobs`) is the most reliable test board (100% static HTML).

---

### Phase 3: Classifier & Notifications ✅ COMPLETE
- [x] Created `classifier.py` with `score_job_match()` using Groq LLM (0–100 scoring).
- [x] `USER_PROFILE` dynamically loaded from `profile.txt` (not hardcoded).
- [x] Created `profile.txt` — user-editable career target file.
- [x] Created `notifier.py` — sends rich Markdown Telegram alerts.
- [x] Classifier test confirmed: Backend Python FastAPI role = **95/100**. Sales SDR role = **0/100**.
- [x] Created `agent.py` — the full autonomous pipeline orchestrator.
- [x] Full agent run confirmed working: Loaded 27 seen jobs, found 2 new, scored SDR at 0, skipped correctly.

**Key Learnings from Phase 3:**
- Low `temperature` (0.0–0.1) on the scorer is critical for deterministic, consistent scores.
- Null-title job entries (garbage LLM extractions) must be skipped BEFORE scoring to save API tokens.
- `time.sleep(0.5)` between Groq scoring calls prevents rate limiting on large batches.

---

### Phase 4: Node.js/NestJS Agent Integration ✅ COMPLETE
- [x] Migrated from Python to a NestJS/TypeScript architecture (`backend`).
- [x] Replicated Hermes Agent ReAct loop using `AgentModule` and LangChain.js.
- [x] Implemented Playwright in `DiscoveryModule` for robust LinkedIn scraping.
- [x] Created dedicated Playwright `LinkedInAgent` with browser fingerprint masking and human emulation.
- [x] Swapped out old, expired DuckDuckGo scraping inside CareerPages, Greenhouse/YC, and Wellfound/Glassdoor agents for the real-time TinyFish Search API.
- [x] Configured MVP target threshold to return 5 high-match jobs per query.
- [x] Integrated `IntelligenceModule` with Groq LLM (Llama 3.3) for profile matching.
- [x] Swapped `axios` for native `fetch` in `NotifierModule` for better security.
- [x] Refactored LLM matching to use a multi-criteria score (Skills, Experience, Location) calculated via JSON structured output and aggregated with weighted code logic.
- [x] Created `ProfileParser` to isolate profile config concerns and support multi-criteria parameters.
- [x] Replaced `ScrapedJob` with a unified `Job` contract and introduced SHA-256 compound hashing to prevent false-positive deduplication.
- [x] Separated LLM caching from accepted matches using `seen_jobs.json` (reverted from `processed_jobs.json` for backwards compatibility with external scripts).
- [x] Added structured prefix logging (`[SCRAPER]`, `[SCORER]`, `[NOTIFIER]`, etc.) across all components.
- [x] Implemented dynamic 30-day freshness filtering (`after:YYYY-MM-DD`) on search engine queries to ensure all scraped links are active and not expired.
- [x] Resolved location-restricting search bugs by enabling compound queries (e.g. `("Ahmedabad" OR "Remote")`) when remote preference is active.
- [x] Completely eliminated mock/dummy fallback data from all discovery agents to prevent misleading or duplicate results.
- [x] Reorganized parallel scraping agents into three highly optimized search pipelines:
  * **India-Focused Pipeline**: Instahyre, Cutshort, Naukri.
  * **Startup Boards Pipeline**: YC India and Wellfound India.
  * **ATS Portals Pipeline**: Greenhouse, Lever, Ashby, Workable.
  * **LinkedIn Scraper**: Playwright with guest pagination fixes.
- [x] Implemented LLM-driven metadata extraction to identify true job locations and companies from titles and snippets, enabling the Scorer to reject false-positive location matches.
- [x] Refined `IndiaFocusedAgent` search queries to target only individual postings (`/job/`, `/job-listings-`) instead of aggregate directory pages.
- [x] Implemented YC & Wellfound catalog URL exclusion filters (`isCatalogUrl`) to keep search data clean from generic listing indexes.

**Key Learnings from Phase 4:**
- DuckDuckGo / general search engine indexed pages return stale and expired links (e.g., job postings that have already closed). Querying the TinyFish Search API directly provides much fresher, real-time results.
- Injecting custom browser anonymization (overriding `navigator.webdriver`, spoofing languages, and blocking WebGL/Canvas fingerprinting) is essential to bypass bot detection when crawling LinkedIn.
- Emmitting keyboard presses character-by-character with random delays simulates realistic human typing, avoiding instant blocks on login screens.
- Splitting matches into skills, experience, and location scores gives the system granular explainability and keeps LLM token costs identical by retrieving them in a single structured JSON response.
- Compound deduplication hashing (using title, company, location, and source) is far more robust than simple title+company hashes, preventing geographic and source collisions.
- Appending `after:YYYY-MM-DD` directly to Google Search-based API calls filters out old crawled indexes, solving the expired link problem without requiring extra HTTP status checks.
- When search results are empty, returning static dummy jobs unconditionally masks search errors. Removing dummy fallback data completely allows proper, clean live pagination.

---

### Phase 5: Production Recommendation Engine & pgvector Integration ✅ COMPLETE
- [x] Set up PostgreSQL and `pgvector` schema database initialization on module bootstrap.
- [x] Configured local ONNX inference engine via `@xenova/transformers` for fast `bge-small-en-v1.5` embeddings.
- [x] Split user profiles into structured preferences tables, skills tables, and accomplishments/experience text embeddings.
- [x] Added early-stage job validation (duplicate database checks, freshness filters, and non-blocking URL ping tests).
- [x] Implemented structured job requirements extraction with DB caching.
- [x] Developed MatchingService implementing Hard Filters, normalized skill overlap, experience years check, and education level matching.
- [x] Updated AgentService orchestration to run the complete multi-stage pipeline.

---

### Phase 6: Scheduler (Planned)
- [ ] Add daily scheduler (APScheduler or Windows Task Scheduler).
- [ ] Agent automatically runs at 9:00 AM every day without manual trigger.

### Phase 7: Dynamic Company Discovery (Planned)
- [ ] Integrate TinyFish **Search API** to find company career pages by query.
- [ ] Agent can discover new companies dynamically (not just hardcoded URLs).

---

## 🔄 Changelog

*Note: The Changelog has been moved to `CHANGELOG.md` for more detailed tracking.*
