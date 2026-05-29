# 📏 RULES — CareerOS AI Agent Rules & Constraints

> **AI Agent Note:** These are the non-negotiable rules for any AI working on this project. Read and follow them strictly before making any code changes.

---

## 🔒 Security Rules (CRITICAL — Never Violate)

1. **NEVER commit `.env` to git.** The `.env` file is in `.gitignore` for a reason. All real API keys are stored there. Never paste key values into code files.
2. **NEVER hardcode API keys** in any Python file. Always use `os.getenv("KEY_NAME")`.
3. **NEVER expose `seen_jobs.json` content** to external APIs. It contains only hashes, but it is still private user data.

---

## 🤖 AI Coding Rules

1. **No silent failures.** Every API call must have a `try/except` block with a descriptive `print()` message.
2. **Verify API model names before using.** Model names get decommissioned. Check `ai-context/AGENTS.md` Section 6 for the current active model list before writing any LLM call.
3. **Never change `seen_jobs.json` structure.** It must always be a flat JSON array of strings (`List[str]`). Breaking this format breaks the deduplication engine.
4. **Always update `PROGRESS.md` and `CHANGELOG.md` after completing a task.** Mark the relevant checkbox in PROGRESS.md, and add a detailed entry in CHANGELOG.md (Date, Time, Summary, Added, Changed, Fixed) to track progress.
5. **Never run the classifier on jobs with a `null` title.** These are garbage LLM extractions. Skip them and mark them as seen to avoid reprocessing.

---

## 🛠️ Development Workflow Rules

1. **Test before committing.** Always run `python test_keys.py` and `python agent.py` before writing a commit.
2. **Use Conventional Commits.** All git commits must follow the `type(scope): description` format. See `docs/git_commit_guide.md`.
3. **Profile changes go in `profile.txt` only.** The profile is dynamically loaded by the IntelligenceService.
4. **New npm packages must be added using `npm install`** so `package.json` stays updated.
5. **Always update the `ai-context/` folder.** Whenever applicable structural, architectural, or file changes are made anywhere in the project, you MUST update all relevant files in the `ai-context/` folder (RULES, AGENTS, ARCHITECTURE, PROGRESS, CHANGELOG) to reflect the new state of the project.

---

## ⚡ Performance Rules

1. **Add `time.sleep(0.5)` between Groq API calls** in loops to prevent hitting rate limits.
2. **Always deduplicate BEFORE scoring.** Never send a job to the LLM scorer if it is already in `seen_jobs.json`. Scoring wastes expensive API tokens.
3. **Limit LLM context to `page_text[:25000]`** characters per scrape. Sending full multi-megabyte pages causes slow, costly responses.
4. **Keep `temperature=0.0` on the classifier** to ensure deterministic, repeatable scores. Randomness in scoring causes false alerts.

---

## 📂 File Organization Rules

```
CareerOS/
├── ai-context/       ← AI context layer. Update, never delete.
├── docs/             ← Developer reference guides.
├── skills/           ← Hermes Agent skill definitions.
├── *.py              ← Core Python modules (agent, discovery, classifier, notifier).
├── profile.txt       ← User career target. User-edited only.
├── seen_jobs.json    ← Agent memory. Agent-managed only. Never manually edit unless resetting.
├── .env              ← Secrets. NEVER committed to git.
└── .env.example      ← Key template. Always committed to git.
```
