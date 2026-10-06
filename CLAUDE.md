# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

JobSense is a personal, single-user daily-use web app for Aravind's job search (SRE / Platform /
Cloud Infra / DevOps / AI Infra roles, 1–3 YOE, India + remote). Pipeline:

```
Scrape jobs (JobSpy)  →  Pick best-fit pre-built resume (keyword match)  →  Show in a dashboard
                                                                          →  Apply manually, track status
```

**Important deviation from the original design:** `.kiro/specs/job-application-pipeline/design.md`
describes an architecture where Claude tailors a resume per job and scores it against the JD via
the Anthropic API. The code as written does **not** do that — `resume_adapter.py` and
`ats_service.py` both explicitly say "zero Claude calls" in their docstrings. Instead, the pipeline
picks the best-matching resume out of 6 pre-built PDFs (`backend/resumes/`) using pure keyword
overlap, and (optionally) computes an ATS score the same way. `anthropic` is still a dependency and
`ANTHROPIC_API_KEY`/`llm_configured` plumbing exists end-to-end (health check, Settings page), but
nothing currently calls the Claude API. Don't assume the README's "tailors your resume using
Claude" framing reflects current behavior — verify against `resume_adapter.py` before changing
anything resume-related.

## Repository layout

- `backend/` — FastAPI + SQLAlchemy + SQLite, Python 3.10+
- `frontend/` — React 18 + TypeScript + Vite + Tailwind + TanStack Query SPA
- `JobSpy/` — vendored clone of the third-party `python-jobspy` scraping library, imported
  in-process (not a package install) so the scraper can call its internals directly. It's
  git-ignored from this repo (`JobSpy/` in `.gitignore`) and has its own `.git`/README — treat it
  as an external dependency, not project code to modify casually.
- `.kiro/specs/` — original design docs (high-level architecture, sequence diagrams). Useful for
  intent, but see the deviation note above before trusting it as current truth.
- `deploy/jobsense.service` — systemd unit for the EC2 always-on deployment (single worker only).
- `Aravind_SRE_Master_Resume.pdf`, `frsh-contribution.md` — personal source-of-truth documents for
  resume content; both git-ignored as personal data.

## Commands

### Backend (from `backend/`)

```bash
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# Scraper needs JobSpy on the path (scraper.py also does this automatically via a
# relative path if JobSpy/ exists as a sibling of backend/, but set it explicitly if not):
export PYTHONPATH=/Users/avenkedeshwaran/IITMBS/Job-sense/JobSpy

python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

- Health check: `curl http://localhost:8000/api/health` → `{"ok":true,"llm_configured":bool}`
- Interactive API docs: `http://localhost:8000/docs`
- No test suite or linter is configured in this repo — there are no `pytest`/`ruff`/`mypy` configs
  to run.
- Reset DB: delete `backend/jobsense.db` (recreated on next startup) or run the delete snippet in
  README.md's "Resetting the Database" section.
- Seed demo data: `python3 seed_data.py` (from an activated venv).

### Frontend (from `frontend/`)

```bash
npm install
npm run dev          # Vite dev server on :5173, proxies /api → localhost:8000
npm run build        # tsc typecheck + vite build → dist/ (also what CI-less "typecheck" looks like)
npm run preview
```

There's no separate `tsc --noEmit` script — `npm run build` is the way to typecheck.

### Running both together

Two terminals: backend on :8000 (with `PYTHONPATH` set), frontend on :5173. In production, one
process serves both — `backend/app/main.py` mounts `frontend/dist/` as static files at `/` when
that directory exists, so there's no CORS/dual-origin concern in prod (only in local dev, where
Vite's proxy handles it).

## Backend architecture

Request flow: FastAPI routes in `main.py` → `repository.py` (SQLAlchemy queries, the only place
that touches `Job`/`PipelineRun`/`Schedule` ORM models directly) → SQLite.

**Pipeline runs are async via a bare daemon thread**, not a task queue (despite the design doc
proposing one). `POST /api/runs` creates a `PipelineRun` row, then
`PipelineOrchestrator.run_in_background()` spawns a `threading.Thread` and returns immediately
(202 Accepted). Progress is tracked two ways simultaneously: a module-level `_active_runs` dict in
`orchestrator.py` (in-memory, lost on restart) and the `PipelineRun` DB row (persistent) — the
frontend polls `GET /api/runs/{id}` which currently only reads the DB row, not `_active_runs`.

Orchestrator phases, all synchronous within the background thread:
1. **Scrape** (`scraper.py` → `ScraperAdapter.scrape()`) — imports the vendored JobSpy, runs a
   matrix of `role_queries × search_passes` (10 roles × 14 city/remote passes = ~140 scrape calls
   per run, 5s sleep between each), filters by experience-range regex heuristics and a minimum
   count of matched tech keywords (`CORE_TECH_PATTERNS`), dedupes by `job_url`. Results upsert into
   `jobs` (`repository.upsert_jobs`) — existing rows get volatile fields refreshed but
   `application_status`/`ats_score`/etc. are preserved.
2. **Match resume** (`resume_adapter.py`) — for each unprocessed job, keyword-scores the JD against
   6 hardcoded resume profiles (`RESUME_CATALOG`) and picks the best match (defaults to `sre` if no
   keywords hit). No LLM call.
3. **Optional ATS score** (`ats_service.py`, gated by `enable_ats` param) — keyword-overlap score
   (0–100) between the chosen resume's markdown and the JD. No LLM call.

`scheduler.py` runs the same orchestrator on a recurring interval via a second background thread,
persisted in the single-row `Schedule` table so it survives restarts (`resume_on_startup()`).
Overlap is prevented by checking for an in-progress `PipelineRun` before triggering — **not** by
thread coordination, so don't assume `scheduler.py` and a manual `POST /api/runs` can't race.

`funnel.py` reconstructs a Sankey-style application funnel from the single `application_status`
field each job carries (jobs don't have status history — only current status). It uses "cumulative
reach" math (a stage's flow = jobs sitting there + everything that progressed further) to
approximate a funnel from point-in-time data; `FUNNEL_STATUSES` order there is the canonical
pipeline order and also drives the frontend's status dropdown (`frontend/src/utils/status.ts`
mirrors it — keep both in sync if you add a status).

All API datetimes are serialized with explicit UTC offsets (`schemas.py::_utc_iso`) specifically so
the frontend's IST-conversion helpers (`frontend/src/utils/time.ts`) parse them correctly across
browsers (there was a prior iOS Safari bug with bare datetime strings — see git history). If you
add a new datetime field to a schema, serialize it through `_utc_iso`, not the Pydantic default.

## Frontend architecture

Single-page app, no router — `App.tsx` holds a `page` string in state and conditionally renders one
of `Dashboard` / `JobsTable` / `FunnelChart` / `RunHistory` / an inline Settings block.
`src/api.ts` is the single fetch client (thin wrapper, no generated client) — all backend calls go
through the `api` object there. `src/types.ts` mirrors the backend Pydantic schemas by hand; keep
them in sync manually when `schemas.py` changes.

State/data-fetching is TanStack Query throughout (polling via `refetchInterval`, e.g. job counts in
`App.tsx`, pipeline run progress) — there's no global client state store beyond the query cache.

`src/utils/status.ts` and `src/utils/time.ts` are the two cross-cutting sources of truth (status
labels/badge colors mirroring `funnel.py`'s `FUNNEL_STATUSES`, and UTC→IST datetime formatting) —
most components consume these rather than reimplementing formatting/labels locally.

## Deployment notes (see DEPLOY.md for full detail)

- Vercel can only host the frontend (stateless serverless, no persistent SQLite/background
  threads) — the backend needs an always-on host.
- Recommended path: single EC2 box running both frontend (built, served as static files by
  FastAPI) and backend behind one uvicorn process — see `deploy/jobsense.service`.
- **Single worker only, always.** Multiple uvicorn workers would each run their own scheduler
  thread, causing duplicate scheduled pipeline runs. Never add `--workers` to the systemd unit or
  any prod invocation.
- Alternative: frontend on Vercel + backend on Render/Railway/Fly, wired via `VITE_API_URL` (build
  env) and `FRONTEND_ORIGINS` (backend CORS env, comma-separated).
