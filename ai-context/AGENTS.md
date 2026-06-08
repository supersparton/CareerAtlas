# 🤖 AI AGENT CONTEXT — CareerOS (CareerAtlas)

> **READ THIS FILE FIRST.** If you are an AI assistant starting a new session on this project, this file is your single source of truth. Read all files in this `ai-context/` folder before taking any action. Do NOT hallucinate missing context — it is documented here.

---

## 1. What Is This Project?

**CareerOS** (also called **CareerAtlas**) is an autonomous AI Career Operating System built in **Node.js/NestJS**. It is a personal job-hunting agent that:
- Scrapes LinkedIn and company career pages using **Playwright**.
- Deduplicates jobs using a local SHA-256 hash store (`seen_jobs.json`).
- Uses **Groq LLM (Llama 3.3)** via **LangChain** to semantically score each new job against the user's target profile (`profile.txt`).
- Sends high-scoring job matches (60/100 or higher) as instant, rich-formatted alerts to the user's Telegram bot via native `fetch`.

**The ultimate goal:** An autonomous, self-improving agentic system that replaces manual job searching.

---

## 2. Project Location
- **Workspace Root:** `c:\Users\POOJAN\OneDrive\Documents\CareerOS\`
- **NestJS Backend:** `c:\Users\POOJAN\OneDrive\Documents\CareerOS\backend\`

---

## 3. Current Version
- **Version:** V1 — Core Hunter
- **Status:** ✅ Core pipeline complete. Successfully migrated from Python to NestJS.
- **See full roadmap:** `ai-context/PROGRESS.md`

---

## 4. File Map (What Each File Does)

| File | Purpose |
| :--- | :--- |
| `src/agent/agent.service.ts` | 🧠 **Main Orchestrator.** Replicates the Hermes Agent ReAct loop: scrape → deduplicate → score → alert. Extracts location dynamically. |
| `src/discovery/discovery.module.ts` | 🕸️ **Discovery Module.** Wires and exports the parallel scraper agents. |
| `src/discovery/linkedin.agent.ts` | 🕵️ **LinkedIn Agent.** Direct Playwright scraper with stealth fingerprint masking, human keyboard typing, and lazy-scrolling card parser. |
| `src/discovery/ats-portals.agent.ts` | 🔗 **ATS Portals Agent.** Queries the TinyFish Search API for Lever/Ashby/Workable/Greenhouse jobs. |
| `src/discovery/startup-boards.agent.ts` | 🥬 **Startup Boards Agent.** Queries the TinyFish Search API for YC India & Wellfound India job boards. |
| `src/discovery/india-focused.agent.ts` | 💼 **India-Focused Agent.** Queries the TinyFish Search API for Instahyre, Cutshort, and Naukri listings. |
| `src/intelligence/intelligence.service.ts` | 📊 **Job Scorer.** Uses `@langchain/groq` to score jobs against `profile.txt`. |
| `src/notifier/notifier.service.ts` | 📲 **Telegram Alerter.** Sends matched job cards to Telegram using native Node `fetch`. |
| `src/memory/memory.service.ts` | 🗃️ **Agent Memory.** Reads/writes SHA-256 hashes to `seen_jobs.json`. |
| `profile.txt` | 👤 **User Career Profile.** User-edited file detailing skills, target roles, and location preferences (e.g. Ahmedabad). |
| `seen_jobs.json` | 🗃️ **Agent Memory File.** JSON array stored in the project root. |
| `.env` | 🔒 **Secret Store.** Stored in the root folder. Read by NestJS ConfigModule. |

---

## 5. Environment Variables Required

| Variable | Service | How to Get |
| :--- | :--- | :--- |
| `GROQ_API_KEY` | Groq LLM Inference | [console.groq.com](https://console.groq.com) → API Keys |
| `TINYFISH_API_KEY` | TinyFish Search API | [agent.tinyfish.ai/api-keys](https://agent.tinyfish.ai/api-keys) |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot | Create bot via `@BotFather` in Telegram |
| `TELEGRAM_CHAT_ID` | Telegram Chat Target | Get from `getUpdates` after sending bot a message |
| `USE_OLLAMA` | Local LLM Bypass | Set to `true` to force local model execution |
| `OLLAMA_BASE_URL` | Local LLM Url | Default is `http://localhost:11434` |
| `OLLAMA_MODEL` | Local LLM Model | Default is `llama3` (or run `llama3.2` locally) |

---

## 6. Active Model Configuration

| Component | Model | Provider | Why |
| :--- | :--- | :--- | :--- |
| Job Scorer | `llama-3.3-70b-versatile` | Groq | Accurate semantic reasoning, fast, supported by LangChain. |
| Primary Scorer | `gemini-2.5-flash` | Gemini | Zero library footprint REST endpoint, highly accurate. |
| Local Scorer | `llama3.2` or `llama3` | Ollama (Local) | Bypasses rate-limiting constraints for local development. |

> ⚠️ **IMPORTANT:** Never use `modelName` in the ChatGroq constructor. LangChain specifically requires the property to be `model`.

---

## 7. Key Technical Decisions & Why

1. **NestJS over Python:** Required because free hosting services (Render, Vercel) have better support and memory profiles for Node/TypeScript services.
2. **Playwright + TinyFish Hybrid Scraper:** Playwright is used exclusively for direct LinkedIn scraping to manage page interaction, session authentication, and list scrolling (with fingerprint masking). For Lever, Ashby, Greenhouse, Wellfound, and Glassdoor, we query the TinyFish Search API directly. This provides fresh, real-time listings without search engine indexing delays, bypasses JS-only blocks, and runs 10x faster with zero local browser overhead.
3. **LangChain for Intelligence:** Provides structured output parsing (Zod/JSON) out-of-the-box, ensuring reliable `JobScore` interfaces.
4. **Native Fetch over Axios:** Reduces dependency vulnerabilities.
5. **SHA-256 Hashing for Deduplication:** Storing a hash of `title+company` ensures O(1) lookup without taking up disk space.

---

## 8. How to Run

```cmd
# 1. Navigate to the backend folder
cd backend

# 2. Run the NestJS application
npm run start
```
