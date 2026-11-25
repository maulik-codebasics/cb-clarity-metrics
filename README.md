# Clarity Insights

Daily history of Microsoft Clarity behaviour metrics for Codebasics: an ETL that calls the Clarity Data Export API once a day, a pipeline monitoring UI, and an analytics dashboard. The full spec is in [PRD.md](PRD.md).

> **Status:** milestone 1 of 8 (database, ETL core, CLI). The web UI, auth, alerts, Docker setup and full deployment docs come in later milestones.

## Local setup

Requirements: Node 22+, PostgreSQL 16.

```bash
npm install
cp .env.example .env   # set DATABASE_URL; keep CLARITY_MOCK=true for development
npm run db:migrate:dev
npm run db:seed        # KPI definitions, pull configs, 90 days of demo data
```

With `CLARITY_MOCK=true` the ETL reads `fixtures/clarity/*.json` and never calls Clarity, so development doesn't use up the 10 calls/day.

## ETL commands

| Command | What it does |
|---|---|
| `npm run etl:run` | Scheduled run (cron). Never uses the reserved calls. Exit code 0 = success or skipped, 2 = partial, 1 = failed. |
| `npm run etl:run -- --manual --by=you@codebasics.io` | Manual late run, e.g. after a failed 00:30 run. Passing `--manual` confirms that it may use the reserved calls. |
| `npm run etl:reprocess -- --runId=<uuid>` | Re-parse a run's stored raw responses. Costs no API calls. |
| `npm run etl:health` | Exit 1 (and alert) if no run has collected data in 26 hours. |
| `npm run etl:purge-raw` | Delete raw responses older than `RAW_RETENTION_DAYS` (default 180). |

Example crontab entry, with the server clock in IST:

```cron
30 0 * * *  cd /app && npm run etl:run
0 */6 * * * cd /app && npm run etl:health
0 3 * * 0   cd /app && npm run etl:purge-raw
```

## Tests

```bash
npm test                  # unit + integration
npm run test:unit         # no database needed
npm run test:integration  # needs DATABASE_URL_TEST (a separate database; it's wiped)
```

Integration tests run the real ETL against a test Postgres, with Clarity mocked by MSW.

## Verify the KPI mappings after the first real run

Field names below come from Clarity's documentation and sample responses, not yet from our own data. After the first real run, check them on the run's raw response and fix any mismatch in `kpi_definitions` (Settings page, once built):

- [ ] `RageClickCount`, `DeadClickCount`, `QuickbackClick`, `ScriptErrorCount` each have `sessionsWithMetricPercentage`.
- [ ] `ScrollDepth` has `averageScrollDepth` (guess).
- [ ] `EngagementTime` has `totalTime`, and whether `activeTime` is the better "session duration" (guess). Check the unit (seconds?).
- [ ] `Traffic.totalSessionCount` is present for every dimension value (needed for session-weighted averages).
- [ ] The URL dimension key in `url` pull responses, and whether values include query strings.
