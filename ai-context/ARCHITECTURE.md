# 🏗️ ARCHITECTURE — CareerOS V1

> **AI Agent Note:** This document maps how the system is structured and how data flows between modules. Use this to understand where to make changes without breaking the pipeline.

---

## System Data Flow Diagram

```
[Job Boards & Search Indexes]
         │
         ▼
┌─────────────────────┐
│ DiscoveryModule     │  ← Multi-agent network (Playwright & TinyFish Search)
│ (4 parallel agents) │
└─────────────────────┘
         │  ScrapedJob[] (title, company, url)
         ▼
┌─────────────────────┐
│  MemoryModule       │  ← SHA-256 hash each job, skip if in seen_jobs.json
│  (seen_jobs.json)   │
└─────────────────────┘
         │  Only NEW jobs pass through
         ▼
┌─────────────────────┐
│   Groq LLM Scorer   │  ← Compare each job to profile.txt (0–100 score)
│  (llama-3.3-70b)    │
└─────────────────────┘
         │  score >= 60?
         ▼
┌─────────────────────┐
│  Telegram Notifier  │  ← Send rich Markdown job card to user's phone
│  (Bot API)          │
└─────────────────────┘
```

---

## Module Dependency Map

```
backend/src/
  ├── agent/agent.module.ts (Orchestrator Loop)
  │
  ├── discovery/discovery.module.ts
  │     ├── linkedin.agent.ts               → Direct Playwright Stealth Scraper
  │     ├── ats-portals.agent.ts            → TinyFish Search API (Lever/Ashby/Workable/Greenhouse)
  │     ├── startup-boards.agent.ts         → TinyFish Search API (YC/Wellfound)
  │     └── india-focused.agent.ts          → TinyFish Search API (Instahyre/Cutshort/Naukri)
  │
  ├── intelligence/intelligence.module.ts
  │     ├── loadProfile()         → ../profile.txt (read & parse target location)
  │     └── scoreJob()            → Langchain + Groq API
  │
  ├── memory/memory.module.ts
  │     └── isJobSeen()           → ../seen_jobs.json (read/write)
  │
  └── notifier/notifier.module.ts
        └── sendJobAlert()        → Telegram API (native fetch)
```

---

## Target Job Board Sources (V1)

| Board | URL | Reliability | Notes |
| :--- | :--- | :--- | :--- |
| LinkedIn | `https://linkedin.com/jobs` | ✅ Upgraded | Direct Playwright scraping with stealth fingerprint masking and custom human emulated login |
| Greenhouse / YC | `https://boards.greenhouse.io` | ✅ Excellent | Real-time queries via TinyFish Search API |
| Lever / Ashby / Workable | `https://lever.co` | ✅ Excellent | Real-time queries via TinyFish Search API, bypassing JS-only blocks |
| Wellfound / Glassdoor | `https://wellfound.com/jobs` | ✅ Excellent | Real-time queries via TinyFish Search API |


---

## API Endpoints Used

| Service | Endpoint | Method | Auth |
| :--- | :--- | :--- | :--- |
| Telegram Send | `https://api.telegram.org/bot{TOKEN}/sendMessage` | POST | Token in URL |

---

## V2 Architecture Changes (Planned)

In V2 (Smart Engine), we will:
1. **Add LangGraph.js** for stateful, multi-step agent workflows (to replace the manual loop in `agent.service.ts`).
2. **Add Vector Memory** (ChromaDB or Supabase pgvector) so the agent remembers your past applications and preferences across sessions.
3. **Add Cover Letter Generator** — a second LLM call that drafts a personalized cover letter for each matched job.
4. **Add Multi-Agent System** — Supervisor Agent coordinates Scraper Agent, Scorer Agent, and Writer Agent in parallel.
