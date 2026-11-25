/**
 * npm run db:seed
 *
 * 1. Upserts KPI definitions and pull configs (existing rows are left as they
 *    are, so mapping edits made in Settings survive a re-seed).
 * 2. Adds 90 days of realistic demo runs and metrics, only when the database
 *    has no runs yet and NODE_ENV is not production.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { DEFAULT_PULLS } from '../src/etl/pulls.config';
import { flattenClarityResponse } from '../src/etl/flatten';
import { snapshotDateFor } from '../src/etl/snapshot-date';
import { ErrorCode, KpiAggregation, KpiUnit, RunStatus, RunTrigger, StepStatus } from '../src/generated/prisma/enums';
import type { Prisma } from '../src/generated/prisma/client';
import { createPrismaClient } from '../src/lib/db';
import { addDaysToIsoDate, isoDateToUtc } from '../src/lib/time';

/**
 * Seeded KPI mappings. Fields marked "verify" are guesses until checked
 * against a real Clarity response (README: KPI mapping checklist).
 */
const DEFAULT_KPIS = [
    {
        key: 'rage_clicks_pct',
        label: 'Rage clicks',
        metricName: 'RageClickCount',
        field: 'sessionsWithMetricPercentage',
        unit: KpiUnit.percent,
        aggregation: KpiAggregation.weighted_avg,
        higherIsBetter: false,
    },
    {
        key: 'dead_clicks_pct',
        label: 'Dead clicks',
        metricName: 'DeadClickCount',
        field: 'sessionsWithMetricPercentage',
        unit: KpiUnit.percent,
        aggregation: KpiAggregation.weighted_avg,
        higherIsBetter: false,
    },
    {
        key: 'quick_backs_pct',
        label: 'Quick backs',
        metricName: 'QuickbackClick',
        field: 'sessionsWithMetricPercentage',
        unit: KpiUnit.percent,
        aggregation: KpiAggregation.weighted_avg,
        higherIsBetter: false,
    },
    {
        key: 'js_errors_pct',
        label: 'JavaScript errors',
        metricName: 'ScriptErrorCount',
        field: 'sessionsWithMetricPercentage',
        unit: KpiUnit.percent,
        aggregation: KpiAggregation.weighted_avg,
        higherIsBetter: false,
    },
    {
        key: 'total_sessions',
        label: 'Total sessions',
        metricName: 'Traffic',
        field: 'totalSessionCount',
        unit: KpiUnit.count,
        aggregation: KpiAggregation.sum,
        higherIsBetter: true,
    },
    {
        key: 'pages_per_session',
        label: 'Avg pages per session',
        metricName: 'Traffic',
        field: 'pagesPerSessionPercentage',
        unit: KpiUnit.ratio,
        aggregation: KpiAggregation.weighted_avg,
        higherIsBetter: true,
    },
    {
        key: 'scroll_depth',
        label: 'Avg scroll depth',
        metricName: 'ScrollDepth',
        field: 'averageScrollDepth',
        unit: KpiUnit.percent,
        aggregation: KpiAggregation.weighted_avg,
        higherIsBetter: true,
    }, // verify
    {
        key: 'session_duration',
        label: 'Avg session duration',
        metricName: 'EngagementTime',
        field: 'totalTime',
        unit: KpiUnit.seconds,
        aggregation: KpiAggregation.weighted_avg,
        higherIsBetter: true,
    }, // verify
].map((kpi, index) => ({ ...kpi, displayOrder: index + 1 }));

const DEMO_DAYS = 90;
const TIME_ZONE = process.env.APP_TIMEZONE ?? 'Asia/Kolkata';

// Deterministic PRNG so the demo data is the same on every machine.
let seed = 20261125;
function random(): number {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
}
const jitter = (value: number, pct: number) => value * (1 + (random() * 2 - 1) * pct);
const round = (value: number, digits = 2) => Number(value.toFixed(digits));

type Extra = Record<string, string>;

/** Build a Clarity-shaped response block for one dimension combination. */
function metricBlock(extra: Extra, sessions: number, quality: number) {
    const pct = (base: number) => round(jitter(base * quality, 0.12));
    const frustration: Array<[string, number]> = [
        ['DeadClickCount', pct(6.5)],
        ['RageClickCount', pct(1.2)],
        ['QuickbackClick', pct(9.2)],
        ['ExcessiveScroll', pct(3.0)],
        ['ScriptErrorCount', pct(4.6)],
        ['ErrorClickCount', pct(0.9)],
    ];
    return [
        {
            metricName: 'Traffic',
            information: [
                {
                    ...extra,
                    totalSessionCount: String(Math.round(sessions)),
                    totalBotSessionCount: String(Math.round(sessions * 0.01)),
                    distinctUserCount: String(Math.round(sessions * 0.74)),
                    pagesPerSessionPercentage: round(jitter(2.1 / quality, 0.08)),
                },
            ],
        },
        {
            metricName: 'EngagementTime',
            information: [
                {
                    ...extra,
                    totalTime: String(Math.round(jitter(310 / quality, 0.1))),
                    activeTime: String(Math.round(jitter(180 / quality, 0.1))),
                },
            ],
        },
        { metricName: 'ScrollDepth', information: [{ ...extra, averageScrollDepth: round(jitter(57 / quality, 0.06)) }] },
        ...frustration.map(([metricName, value]) => ({
            metricName,
            information: [
                {
                    ...extra,
                    sessionsCount: String(Math.round(sessions)),
                    sessionsWithMetricPercentage: value,
                    sessionsWithoutMetricPercentage: round(100 - value),
                    subTotal: String(Math.round((sessions * value) / 100)),
                },
            ],
        })),
    ];
}

function mergeBlocks(blocks: ReturnType<typeof metricBlock>[]) {
    const merged = new Map<string, { metricName: string; information: Array<Record<string, unknown>> }>();
    for (const block of blocks) {
        for (const metric of block) {
            const entry = merged.get(metric.metricName) ?? { metricName: metric.metricName, information: [] };
            entry.information.push(...metric.information);
            merged.set(metric.metricName, entry);
        }
    }
    return [...merged.values()];
}

const URLS: Array<[string, number, number]> = [
    ['https://codebasics.io/', 0.3, 1.0],
    ['https://codebasics.io/courses', 0.2, 0.9],
    ['https://codebasics.io/bootcamps/data-analytics', 0.14, 1.1],
    ['https://codebasics.io/courses/power-bi-data-analysis', 0.1, 0.95],
    ['https://codebasics.io/login', 0.08, 1.4],
    ['https://codebasics.io/checkout', 0.05, 1.6],
    ['https://codebasics.io/resources', 0.04, 0.8],
];

/** Clarity-shaped payload per pull for one day. */
function demoPayloads(sessions: number, quality: number): Record<string, unknown> {
    return {
        overall: metricBlock({}, sessions, quality),
        device: mergeBlocks([
            metricBlock({ Device: 'Mobile' }, sessions * 0.55, quality * 1.2),
            metricBlock({ Device: 'PC' }, sessions * 0.43, quality * 0.8),
            metricBlock({ Device: 'Tablet' }, sessions * 0.02, quality),
        ]),
        source_medium: mergeBlocks([
            metricBlock({ Source: 'google', Medium: 'organic' }, sessions * 0.46, quality),
            metricBlock({ Source: 'youtube.com', Medium: 'referral' }, sessions * 0.29, quality * 1.1),
            metricBlock({ Source: '(direct)', Medium: '(none)' }, sessions * 0.19, quality * 0.9),
            metricBlock({ Source: 'newsletter', Medium: 'email' }, sessions * 0.06, quality * 0.75),
        ]),
        url: mergeBlocks(URLS.map(([url, share, q]) => metricBlock({ URL: url }, sessions * share, quality * q))),
    };
}

async function seedDefinitions(prisma: ReturnType<typeof createPrismaClient>) {
    for (const kpi of DEFAULT_KPIS) {
        await prisma.kpiDefinition.upsert({ where: { key: kpi.key }, create: kpi, update: {} });
    }
    for (const pull of DEFAULT_PULLS) {
        await prisma.pullConfig.upsert({ where: { key: pull.key }, create: { ...pull, dimensions: [...pull.dimensions] }, update: {} });
    }
    console.log(`Seeded ${DEFAULT_KPIS.length} KPI definitions and ${DEFAULT_PULLS.length} pull configs`);
}

async function seedDemoData(prisma: ReturnType<typeof createPrismaClient>) {
    const latestSnapshot = snapshotDateFor(new Date(), TIME_ZONE);
    const firstSnapshot = addDaysToIsoDate(latestSnapshot, -(DEMO_DAYS - 1));
    const missingDays = new Set([22, 57]); // permanent gaps
    const partialDays = new Set([9, 41, 73]); // url pull rate-limited
    const lateRunDay = 33; // 00:30 run failed, admin re-ran at 10:15 IST

    const runs: Prisma.PipelineRunCreateManyInput[] = [];
    const steps: Prisma.PipelineRunStepCreateManyInput[] = [];
    const calls: Prisma.ApiCallLogCreateManyInput[] = [];
    const metrics: Prisma.MetricValueCreateManyInput[] = [];

    const addRun = (input: {
        snapshot: string;
        startedAt: Date;
        trigger: RunTrigger;
        triggeredBy?: string;
        failPulls?: Record<string, { code: ErrorCode; http: number | null; message: string; skipped?: boolean }>;
        payloads?: Record<string, unknown>;
    }) => {
        const runId = randomUUID();
        let t = input.startedAt.getTime();
        let succeeded = 0;
        let failed = 0;
        let skipped = 0;
        let rowsFetched = 0;
        let metricsWritten = 0;
        let callsUsed = 0;
        const problems: string[] = [];
        let firstCode: ErrorCode | null = null;
        const budgetDate = isoDateToUtc(addDaysToIsoDate(input.snapshot, 1));

        for (const pull of DEFAULT_PULLS) {
            const fail = input.failPulls?.[pull.key];
            const duration = Math.round(800 + random() * 2500);
            const stepStart = new Date(t);
            t += duration;
            const stepId = randomUUID();
            if (fail) {
                firstCode ??= fail.code;
                problems.push(`${pull.key}: ${fail.code} – ${fail.message}`);
                if (fail.skipped) {
                    skipped += 1;
                } else {
                    failed += 1;
                    callsUsed += 1;
                    calls.push({ runId, stepId, calledAt: stepStart, httpStatus: fail.http, budgetDate });
                }
                steps.push({
                    id: stepId,
                    runId,
                    pullKey: pull.key,
                    dimensions: [...pull.dimensions],
                    attempt: 1,
                    httpStatus: fail.skipped ? null : fail.http,
                    status: fail.skipped ? StepStatus.SKIPPED_BUDGET : StepStatus.FAILED,
                    startedAt: stepStart,
                    endedAt: new Date(t),
                    durationMs: fail.skipped ? 0 : duration,
                    errorCode: fail.code,
                    errorMessage: fail.message,
                });
                continue;
            }
            const flattened = flattenClarityResponse(input.payloads?.[pull.key], {
                requestedDimensions: pull.dimensions,
                stripUrlQuery: true,
            });
            for (const row of flattened.rows) {
                metrics.push({
                    snapshotDate: isoDateToUtc(input.snapshot),
                    pullKey: pull.key,
                    runId,
                    metricName: row.metricName,
                    field: row.field,
                    dim1Name: row.dims[0].name,
                    dim1Value: row.dims[0].value,
                    dim2Name: row.dims[1].name,
                    dim2Value: row.dims[1].value,
                    dim3Name: row.dims[2].name,
                    dim3Value: row.dims[2].value,
                    value: row.value,
                });
            }
            succeeded += 1;
            callsUsed += 1;
            rowsFetched += flattened.itemCount;
            metricsWritten += flattened.rows.length;
            calls.push({ runId, stepId, calledAt: stepStart, httpStatus: 200, budgetDate });
            steps.push({
                id: stepId,
                runId,
                pullKey: pull.key,
                dimensions: [...pull.dimensions],
                attempt: 1,
                httpStatus: 200,
                status: StepStatus.SUCCESS,
                startedAt: stepStart,
                endedAt: new Date(t),
                durationMs: duration,
                rowsFetched: flattened.itemCount,
                metricsWritten: flattened.rows.length,
            });
        }

        const status =
            succeeded === DEFAULT_PULLS.length ? RunStatus.SUCCESS : succeeded === 0 ? RunStatus.FAILED : RunStatus.PARTIAL_SUCCESS;
        runs.push({
            id: runId,
            trigger: input.trigger,
            triggeredBy: input.triggeredBy ?? 'system',
            status,
            snapshotDate: isoDateToUtc(input.snapshot),
            numOfDays: 1,
            windowStart: new Date(input.startedAt.getTime() - 24 * 3_600_000),
            windowEnd: input.startedAt,
            startedAt: input.startedAt,
            endedAt: new Date(t),
            durationMs: t - input.startedAt.getTime(),
            pullsTotal: DEFAULT_PULLS.length,
            pullsSucceeded: succeeded,
            pullsFailed: failed,
            pullsSkipped: skipped,
            apiCallsUsed: callsUsed,
            rowsFetched,
            metricsWritten,
            errorCode: firstCode,
            errorMessage: problems.length > 0 ? problems.join('; ') : null,
        });
    };

    for (let day = 0; day < DEMO_DAYS; day += 1) {
        const snapshot = addDaysToIsoDate(firstSnapshot, day);
        // 00:30 IST on the next day = 19:00 UTC on the snapshot date.
        const scheduled = new Date(`${snapshot}T19:00:00.000Z`);
        scheduled.setUTCSeconds(Math.round(random() * 40));
        const weekday = new Date(`${snapshot}T00:00:00Z`).getUTCDay();
        const sessions = jitter((4200 + day * 9) * (weekday === 0 || weekday === 6 ? 0.78 : 1), 0.1);
        const quality = 1.08 - day * 0.0012; // slowly improving UX
        const payloads = demoPayloads(sessions, quality);

        if (missingDays.has(day)) {
            const auth = day === 22;
            addRun({
                snapshot,
                startedAt: scheduled,
                trigger: RunTrigger.CRON_CLI,
                failPulls: Object.fromEntries(
                    DEFAULT_PULLS.map((p) => [
                        p.key,
                        auth
                            ? {
                                  code: ErrorCode.AUTH_ERROR,
                                  http: 401,
                                  message: 'Clarity rejected the API token (HTTP 401). Check CLARITY_API_TOKEN.',
                              }
                            : { code: ErrorCode.NETWORK_ERROR, http: null, message: 'Network error calling Clarity: fetch failed' },
                    ]),
                ),
            });
            continue;
        }
        if (day === lateRunDay) {
            addRun({
                snapshot,
                startedAt: scheduled,
                trigger: RunTrigger.CRON_CLI,
                failPulls: Object.fromEntries(
                    DEFAULT_PULLS.map((p) => [
                        p.key,
                        { code: ErrorCode.SERVER_ERROR, http: 503, message: 'Clarity server error (HTTP 503)' },
                    ]),
                ),
            });
            addRun({
                snapshot,
                startedAt: new Date(scheduled.getTime() + (9 * 60 + 45) * 60_000),
                trigger: RunTrigger.MANUAL,
                triggeredBy: 'admin@codebasics.io',
                payloads,
            });
            continue;
        }
        addRun({
            snapshot,
            startedAt: scheduled,
            trigger: RunTrigger.CRON_CLI,
            payloads,
            failPulls: partialDays.has(day)
                ? { url: { code: ErrorCode.RATE_LIMITED, http: 429, message: 'Clarity daily request limit reached (HTTP 429)' } }
                : undefined,
        });
    }

    // One skipped duplicate trigger, so SKIPPED_LOCKED shows in the UI.
    const lockedAt = new Date(`${addDaysToIsoDate(latestSnapshot, -3)}T19:00:05.000Z`);
    runs.push({
        id: randomUUID(),
        trigger: RunTrigger.CRON_HTTP,
        triggeredBy: 'system',
        status: RunStatus.SKIPPED_LOCKED,
        snapshotDate: isoDateToUtc(addDaysToIsoDate(latestSnapshot, -3)),
        startedAt: lockedAt,
        endedAt: lockedAt,
        durationMs: 0,
        errorMessage: 'Another run was in progress',
    });

    await prisma.pipelineRun.createMany({ data: runs });
    await prisma.pipelineRunStep.createMany({ data: steps });
    await prisma.apiCallLog.createMany({ data: calls });
    for (let i = 0; i < metrics.length; i += 5000) {
        await prisma.metricValue.createMany({ data: metrics.slice(i, i + 5000) });
    }
    console.log(
        `Seeded demo data: ${runs.length} runs, ${steps.length} steps, ${metrics.length} metric values (${firstSnapshot} → ${latestSnapshot})`,
    );
}

async function main() {
    const url = process.env.DATABASE_URL;
    if (!url) {
        throw new Error('DATABASE_URL is required');
    }
    const prisma = createPrismaClient(url);
    try {
        await seedDefinitions(prisma);
        if (process.env.NODE_ENV === 'production') {
            console.log('NODE_ENV=production: demo data skipped');
        } else if ((await prisma.pipelineRun.count()) > 0) {
            console.log('Runs already exist: demo data skipped');
        } else {
            await seedDemoData(prisma);
        }
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
