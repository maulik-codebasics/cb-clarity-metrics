<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Clarity Insights: project notes

Read these first:

- [PRD.md](PRD.md): what the app must do. Its changes table and decisions log record every agreed change from the original spec.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): layers, run lifecycle, data model, folder map, milestone status.

## Working rules

- **Build order:** follow the milestones in docs/ARCHITECTURE.md. One `feature/*` branch and one PR per milestone, into `main`.
- **Spec changes:** don't change agreed behaviour silently. If something has to differ from the PRD, ask first, then record it in the PRD's changes table and decisions log.
- **Clarity budget:** 10 calls/day, shared with other tools. Never add code that calls Clarity outside `runPipeline()`. Develop with `CLARITY_MOCK=true`.
- **Never store, log or display `CLARITY_API_TOKEN`.** Pass secrets through `redactText()` / `redactValue()` before storing errors.
- **ETL core stays framework-free:** no Next.js imports in `src/etl/`; dependencies are injected; no `any`.
- **Dates:** business dates are `Asia/Kolkata`, as `YYYY-MM-DD` strings in code (`src/lib/time.ts`). Show the timezone label on every timestamp in the UI.
- **Aggregation in SQL**, including session-weighted averages; validate every API query param with Zod.
- **Uncertain Clarity field names** go in `kpi_definitions` and the README checklist. Never guess silently.

## Commands

- `npm test` (unit + integration; integration needs `DATABASE_URL_TEST`, a separate DB that gets wiped)
- `npx tsc --noEmit`, `npx eslint .`, `npx prettier --write .` before committing
- `npm run db:migrate:dev` after schema changes; `npm run db:seed` for demo data

## Versions to be aware of

Next 16, React 19, Prisma 7 (driver adapter, `prisma.config.ts`, client generated to `src/generated/prisma`), Zod 4, Vitest 5, MSW 3 (`onUnhandledFrame`, not `onUnhandledRequest`), Tailwind 4, Auth.js v5 (beta). TypeScript is pinned to 5.9; don't upgrade to 7 without checking Next support.
