# Architecture

Clarity Insights is **one Next.js application** (App Router, TypeScript) backed by **one Postgres database**. It's built in 8 milestones (PRD §14). Each milestone is a `feature/*` branch merged into `main` through a PR; branch names describe a milestone, not a part of the architecture.

For *what* the app must do, see [PRD.md](../PRD.md). This document covers *how* it's put together.

## Layers

```
┌───────────────────────────────────────────────────────────────┐
│  UI (Next.js pages)                    milestones 3, 5, 6     │
│  /dashboard   /runs   /runs/[id]   /settings                  │
├───────────────────────────────────────────────────────────────┤
│  API routes + Auth (Entra ID)          milestones 2–6         │
│  /api/etl/run  /api/runs  /api/metrics/*  /api/health         │
├───────────────────────────────────────────────────────────────┤
│  Entry points                          milestones 1–2         │
│  CLI scripts (cron) ✅      HTTP trigger (cron URL)           │
├───────────────────────────────────────────────────────────────┤
│  ETL core  (src/etl/)                  milestone 1 ✅         │
│  Clarity client → budget guard → raw storage → parser         │
│  → metric writer; lock, retries, reprocess, health            │
├───────────────────────────────────────────────────────────────┤
│  Database (Postgres + Prisma)          milestone 1 ✅         │
│  runs, steps, raw responses, metrics, call log, KPI defs      │
└───────────────────────────────────────────────────────────────┘
        ▲ Clarity Data Export API          Alerts: Teams/email (milestone 7) ▶
```

The rules that keep the layers apart:

1. **The ETL core is the only code that calls Clarity or writes metrics.** Every way of starting a run (cron CLI, cron HTTP endpoint, the admin's "Run now" button) calls the same `runPipeline()`, so a run behaves the same however it starts.
2. **The dashboard and runs pages only read the database.** They never call Clarity, so viewing the app never spends API calls.
3. **The ETL core doesn't import Next.js.** Its dependencies (Clarity client, database repository, lock, clock, sleep, logger, notifier) are passed in, so it can run from a CLI script, an API route or a test.
4. **All heavy aggregation happens in SQL**, including session-weighted averages. API routes return results, not raw rows.

## A run, step by step

`runPipeline()` in [src/etl/run-pipeline.ts](../src/etl/run-pipeline.ts):

```
trigger (CLI / HTTP / manual)
  │
  ├─ take the Postgres advisory lock ── held? ──▶ record SKIPPED_LOCKED, stop
  ├─ mark runs stuck in RUNNING for over 30 min as FAILED
  ├─ create the run row (RUNNING), snapshot_date = IST today − 1
  │
  ├─ for each enabled pull (overall, device, source_medium, url):
  │     ├─ budget check: calls logged today + 1 ≤ limit?   no ──▶ SKIPPED_BUDGET, skip the rest
  │     ├─ log the API call (before sending, so a crash still counts)
  │     ├─ GET Clarity (numOfDays=1, 60 s timeout)
  │     │     ├─ 5xx / network error ──▶ retry ×2 with backoff (each retry is a call)
  │     │     ├─ 429 ──▶ FAILED, skip the remaining pulls
  │     │     └─ 400 / 401 / 403 / timeout ──▶ FAILED, no retry
  │     ├─ store the raw JSON                        (kept 180 days)
  │     ├─ parse and flatten          parse error ──▶ FAILED, raw kept for reprocessing
  │     └─ replace this pull's metrics for snapshot_date (delete + insert, one transaction)
  │
  ├─ finish the run: SUCCESS / PARTIAL_SUCCESS / FAILED, with counts and errors
  ├─ alert if not SUCCESS
  └─ release the lock
```

**Reprocess** ([src/etl/reprocess.ts](../src/etl/reprocess.ts)) re-runs only the last two steps from stored raw JSON. It's recorded as a new run (`trigger = REPROCESS`, 0 API calls).

## Data model

Full schema: [prisma/schema.prisma](../prisma/schema.prisma). PRD §5 explains each column.

```
pipeline_runs ──< pipeline_run_steps ──< raw_responses
      │                   │
      │                   └──< api_call_log     (budget counting, per budget_date)
      └──< metric_values                        (long/narrow; one row per metric × field × dimensions × day)

pull_configs      which API calls a run makes (seeded from src/etl/pulls.config.ts)
kpi_definitions   maps dashboard KPIs to metric_name + field, unit, aggregation
v_daily_kpis      view: one row per day, one column per KPI (overall pull)
```

Notes:

- **`metric_values` is long and narrow** on purpose. Clarity's field list isn't fixed, so every numeric field is stored as its own row. Unused dimensions are `''`, not NULL, so the unique index (which stops duplicates) works.
- **Dates:** `snapshot_date` is a calendar date in `Asia/Kolkata`. In code, calendar dates are `YYYY-MM-DD` strings (`IsoDate` in [src/lib/time.ts](../src/lib/time.ts)), converted to UTC-midnight `Date`s only at the Prisma boundary.
- **The budget day** (`api_call_log.budget_date`) is the IST date, shifted by `CLARITY_BUDGET_RESET_OFFSET_MINUTES`.

## Folder map

```
prisma/
  schema.prisma              tables and enums
  migrations/                SQL migrations (the view is raw SQL)
  seed.ts                    KPI defs, pull configs, 90 days of demo data
prisma.config.ts             Prisma 7 config (DB URL, seed command)
fixtures/clarity/            sample Clarity responses (mock mode + tests)
scripts/                     CLI entry points: etl-run, etl-reprocess, etl-health, etl-purge-raw
src/
  etl/                       ETL core (no Next.js imports)
    run-pipeline.ts          the orchestrator
    clarity-client.ts        HTTP client + fixture client (CLARITY_MOCK)
    classify-error.ts        HTTP status / exception → error code, retryable?
    flatten.ts               generic response parser
    budget.ts                daily call budget rules
    snapshot-date.ts         snapshot date, budget date, data window
    lock.ts                  Postgres advisory lock
    repository.ts            all ETL database access
    reprocess.ts, health.ts  reprocess a run; 26-hour health check
    notifier.ts              alert interface (log-only until milestone 7)
    factory.ts               wires real dependencies from env vars
    pulls.config.ts          default pulls
  lib/                       shared: env (Zod), db (Prisma), logger (pino), redact, time
  app/                       Next.js pages and API routes (milestone 2 onwards)
  generated/prisma/          Prisma client (generated on npm install; not committed)
tests/
  unit/                      pure functions, no database
  integration/               real ETL + test Postgres, Clarity mocked with MSW
docs/                        this file
```

Planned additions, by milestone: `src/auth.ts` and `src/middleware.ts` (milestone 4), `src/server/queries/` for dashboard SQL (milestone 5), `src/components/` (UI), `src/alerts/` (milestone 7), `e2e/` (Playwright), `Dockerfile` and `docker-compose.yml` (milestone 8).

## Key decisions

| Decision | Why |
|---|---|
| Standalone repo, not part of `lms-web` | Different stack (Next.js + Postgres vs Laravel + MySQL). |
| No backfill; missed days recovered by a same-day manual run | `numOfDays=1` daily is enough. A 3-day call returns one total that can't be split into days reliably. |
| Session-weighted averages for rates over a period | Matches Clarity's figures; a quiet day shouldn't count as much as a busy one. |
| Advisory lock on a dedicated `pg` connection | Prisma's connection pool can't guarantee the same connection for the whole run. |
| Raw JSON stored before parsing | A parser bug never costs a day's data; reprocess costs no API calls. |
| Budget counted from our own call log, conservatively | Clarity's limit is shared and its reset time is undocumented; 2 calls stay reserved. |
| Generic parser, KPI mappings in a table | Clarity field names aren't fully documented; mappings can be fixed in Settings without code changes. |

## Milestones

| # | Milestone | Status |
|---|---|---|
| 1 | Database + ETL core + tests, CLI commands | ✅ [PR #1](https://github.com/maulik-codebasics/cb-clarity-metrics/pull/1) |
| 2 | HTTP cron trigger (`POST /api/etl/run`), `/api/health` | Next |
| 3 | Runs UI: `/runs`, `/runs/[id]` | |
| 4 | Auth: Entra ID, admin/viewer roles | |
| 5 | Dashboard: KPI cards, line chart, top pages | |
| 6 | Settings: pull configs, KPI mappings, discovered fields | |
| 7 | Alerts: Teams webhook, email | |
| 8 | Docs and packaging: Dockerfile, docker-compose, deployment guide, Playwright smoke tests | |
