# 🏗️ ARCHITECTURE — CareerOS V1

> **AI Agent Note:** This document maps how the system is structured and how data flows between modules. Use this to understand where to make changes without breaking the pipeline.

---

## System Data Flow Diagram

```
[LinkedIn / Career Pages]
         │
         ▼
┌─────────────────────┐
│ DiscoveryModule     │  ← Uses Playwright to headlessly scrape dynamic pages
│ (Playwright)        │
└─────────────────────┘
         │  ScrapedJob[] (title, company, link)
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
         │  score >= 70?
         ▼
┌─────────────────────┐
│  Telegram Notifier  │  ← Send rich Markdown job card to user's phone
│  (Bot API)          │
└─────────────────────┘
```

---

## Module Dependency Map

```
career-os-backend/src/
  ├── agent/agent.module.ts (Orchestrator Loop)
  │
  ├── discovery/discovery.module.ts
  │     └── scrapeLinkedInJobs()  → Playwright Engine
  │
  ├── intelligence/intelligence.module.ts
  │     ├── loadProfile()         → ../profile.txt (read)
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
| Hacker News Jobs | `https://news.ycombinator.com/jobs` | ✅ Excellent | 100% static HTML, always works |
| Greenhouse | `https://boards.greenhouse.io/{company}` | ✅ Good | Most companies list jobs directly |
| Ashby ATS | `https://jobs.ashbyhq.com/{company}` | ❌ Blocked | JavaScript-only, TinyFish gets blocked |

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
