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
- [x] Migrated from Python to a NestJS/TypeScript architecture (`career-os-backend`).
- [x] Replicated Hermes Agent ReAct loop using `AgentModule` and LangChain.js.
- [x] Implemented Playwright in `DiscoveryModule` for robust LinkedIn scraping.
- [x] Integrated `IntelligenceModule` with Groq LLM (Llama 3.3) for profile matching.
- [x] Swapped `axios` for native `fetch` in `NotifierModule` for better security.

---

### Phase 5: Scheduler (Planned)
- [ ] Add daily scheduler (APScheduler or Windows Task Scheduler).
- [ ] Agent automatically runs at 9:00 AM every day without manual trigger.

### Phase 6: Dynamic Company Discovery (Planned)
- [ ] Integrate TinyFish **Search API** to find company career pages by query.
- [ ] Agent can discover new companies dynamically (not just hardcoded URLs).

---

## 🔄 Changelog

*Note: The Changelog has been moved to `CHANGELOG.md` for more detailed tracking.*
