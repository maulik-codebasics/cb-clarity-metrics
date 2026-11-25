import { readFileSync } from 'node:fs';
import path from 'node:path';
import { http, HttpResponse } from 'msw/http';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLARITY_ENDPOINT } from '@/etl/clarity-client';
import { checkPipelineHealth } from '@/etl/health';
import { createPgAdvisoryLock } from '@/etl/lock';
import { reprocessRun } from '@/etl/reprocess';
import { STALE_RUN_MESSAGE } from '@/etl/repository';
import { runPipeline } from '@/etl/run-pipeline';
import { isoDateToUtc } from '@/lib/time';
import { BUDGET_DATE, RUN_TIME, SNAPSHOT_DATE, TOKEN, makeDeps, prisma, resetDatabase, useCallsToday } from './helpers';
import { TEST_DATABASE_URL } from './test-db-url';

const fixtureText = (name: string) => readFileSync(path.join(__dirname, '../../fixtures/clarity', name), 'utf8');
const FIXTURE_BY_DIMS: Record<string, string> = {
    '': 'overall.json',
    Device: 'device.json',
    'Source,Medium': 'source_medium.json',
    URL: 'url.json',
};

/** pull key for a request, from its dimension params. */
function pullKeyOf(request: Request): string {
    const url = new URL(request.url);
    const dims = [1, 2, 3].map((i) => url.searchParams.get(`dimension${i}`)).filter(Boolean);
    return { '': 'overall', Device: 'device', 'Source,Medium': 'source_medium', URL: 'url' }[dims.join(',')] ?? 'unknown';
}

const calls: string[] = [];
const server = setupServer();

/** Serve fixtures, except where `overrides[pullKey]` returns a different response. */
function clarity(overrides: Record<string, (attempt: number) => Response> = {}) {
    server.use(
        http.get(CLARITY_ENDPOINT, ({ request }) => {
            expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
            const key = pullKeyOf(request);
            calls.push(key);
            const attempt = calls.filter((c) => c === key).length;
            const override = overrides[key];
            if (override) {
                return override(attempt);
            }
            const url = new URL(request.url);
            const dims = [1, 2, 3]
                .map((i) => url.searchParams.get(`dimension${i}`))
                .filter(Boolean)
                .join(',');
            return new HttpResponse(fixtureText(FIXTURE_BY_DIMS[dims] ?? 'overall.json'), {
                headers: { 'content-type': 'application/json' },
            });
        }),
    );
}

const stepsOf = (runId: string) =>
    prisma.pipelineRunStep.findMany({ where: { runId }, orderBy: [{ startedAt: 'asc' }, { attempt: 'asc' }] });

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(async () => {
    server.close();
    await prisma.$disconnect();
});
beforeEach(async () => {
    calls.length = 0;
    await resetDatabase();
});
afterEach(() => server.resetHandlers());

describe('ETL run', () => {
    it('SUCCESS: calls every pull once, stores raw JSON and metrics', async () => {
        clarity();
        const { deps, notifier } = makeDeps();

        const result = await runPipeline(deps, { trigger: 'CRON_CLI', triggeredBy: 'system' });

        expect(result).toMatchObject({ status: 'SUCCESS', snapshotDate: SNAPSHOT_DATE, apiCallsUsed: 4, pullsSucceeded: 4 });
        expect(calls).toEqual(['overall', 'device', 'source_medium', 'url']);
        const run = await prisma.pipelineRun.findUniqueOrThrow({ where: { id: result.runId } });
        expect(run).toMatchObject({ status: 'SUCCESS', pullsTotal: 4, apiCallsUsed: 4, errorCode: null });
        expect(run.rowsFetched).toBeGreaterThan(0);
        expect(run.metricsWritten).toBe(await prisma.metricValue.count());
        expect(run.endedAt).not.toBeNull();
        expect(run.windowEnd?.toISOString()).toBe(RUN_TIME.toISOString());
        expect(await prisma.rawResponse.count()).toBe(4);
        expect(await prisma.apiCallLog.count({ where: { budgetDate: isoDateToUtc(BUDGET_DATE), httpStatus: 200 } })).toBe(4);
        expect(notifier.notifyRunProblem).not.toHaveBeenCalled();

        const sessions = await prisma.metricValue.findFirstOrThrow({
            where: { pullKey: 'overall', metricName: 'Traffic', field: 'totalSessionCount' },
        });
        expect(sessions.value.toString()).toBe('4821');
        expect(sessions.snapshotDate.toISOString().slice(0, 10)).toBe(SNAPSHOT_DATE);
    });

    it('re-running on the same day replaces metrics instead of duplicating them', async () => {
        clarity();
        const first = await runPipeline(makeDeps().deps, { trigger: 'CRON_CLI', triggeredBy: 'system' });
        const countAfterFirst = await prisma.metricValue.count();

        const second = await runPipeline(makeDeps().deps, { trigger: 'MANUAL', triggeredBy: 'admin@codebasics.io' });

        expect(second.status).toBe('SUCCESS');
        expect(await prisma.metricValue.count()).toBe(countAfterFirst);
        expect(await prisma.metricValue.count({ where: { runId: first.runId } })).toBe(0);
        expect(await prisma.pipelineRun.count()).toBe(2);
    });

    it('PARTIAL_SUCCESS: a pull that keeps returning 500 is retried twice with backoff', async () => {
        clarity({ url: () => new HttpResponse(`upstream exploded, token=${TOKEN}`, { status: 500 }) });
        const { deps, notifier, sleep } = makeDeps();

        const result = await runPipeline(deps, { trigger: 'CRON_CLI', triggeredBy: 'system' });

        expect(result).toMatchObject({ status: 'PARTIAL_SUCCESS', errorCode: 'SERVER_ERROR', apiCallsUsed: 6, pullsFailed: 1 });
        expect(calls.filter((c) => c === 'url')).toHaveLength(3);
        expect(sleep.mock.calls).toEqual([[2000], [4000]]);
        const urlSteps = (await stepsOf(result.runId)).filter((s) => s.pullKey === 'url');
        expect(urlSteps.map((s) => [s.attempt, s.status, s.httpStatus])).toEqual([
            [1, 'FAILED', 500],
            [2, 'FAILED', 500],
            [3, 'FAILED', 500],
        ]);
        // The token never reaches the database.
        expect(JSON.stringify(urlSteps)).not.toContain(TOKEN);
        expect(JSON.stringify(await prisma.pipelineRun.findMany())).not.toContain(TOKEN);
        expect(notifier.notifyRunProblem).toHaveBeenCalledWith(expect.objectContaining({ status: 'PARTIAL_SUCCESS', runId: result.runId }));
    });

    it('recovers when a retry succeeds', async () => {
        clarity({ device: (attempt) => (attempt === 1 ? new HttpResponse(null, { status: 503 }) : HttpResponse.json([])) });
        const result = await runPipeline(makeDeps().deps, { trigger: 'CRON_CLI', triggeredBy: 'system' });
        expect(result).toMatchObject({ status: 'SUCCESS', apiCallsUsed: 5 });
    });

    it('RATE_LIMITED: 429 is not retried and the remaining pulls are skipped', async () => {
        clarity({ device: () => new HttpResponse(null, { status: 429 }) });
        const { deps, notifier } = makeDeps();

        const result = await runPipeline(deps, { trigger: 'CRON_CLI', triggeredBy: 'system' });

        expect(result).toMatchObject({ status: 'PARTIAL_SUCCESS', errorCode: 'RATE_LIMITED', apiCallsUsed: 2, pullsSkipped: 2 });
        expect(calls).toEqual(['overall', 'device']);
        const steps = await stepsOf(result.runId);
        expect(steps.map((s) => [s.pullKey, s.status, s.errorCode])).toEqual([
            ['overall', 'SUCCESS', null],
            ['device', 'FAILED', 'RATE_LIMITED'],
            ['source_medium', 'SKIPPED_BUDGET', 'RATE_LIMITED'],
            ['url', 'SKIPPED_BUDGET', 'RATE_LIMITED'],
        ]);
        expect(notifier.notifyRunProblem).toHaveBeenCalledOnce();
    });

    it('FAILED with RATE_LIMITED when the first pull gets 429', async () => {
        clarity({ overall: () => new HttpResponse(null, { status: 429 }) });
        const result = await runPipeline(makeDeps().deps, { trigger: 'CRON_CLI', triggeredBy: 'system' });
        expect(result).toMatchObject({ status: 'FAILED', errorCode: 'RATE_LIMITED', apiCallsUsed: 1 });
    });

    it('AUTH_ERROR is not retried', async () => {
        clarity({ overall: () => new HttpResponse(null, { status: 401 }) });
        const result = await runPipeline(makeDeps().deps, { trigger: 'CRON_CLI', triggeredBy: 'system' });
        expect(result.errorCode).toBe('AUTH_ERROR');
        expect(calls.filter((c) => c === 'overall')).toHaveLength(1);
    });

    it('PARSE_ERROR keeps the raw response; reprocess fixes it without an API call', async () => {
        clarity({ overall: () => HttpResponse.json({ unexpected: 'shape' }) });
        const first = await runPipeline(makeDeps().deps, { trigger: 'CRON_CLI', triggeredBy: 'system' });
        expect(first).toMatchObject({ status: 'PARTIAL_SUCCESS', errorCode: 'PARSE_ERROR' });
        expect(await prisma.rawResponse.count({ where: { pullKey: 'overall' } })).toBe(1);

        // Simulate the fix: the stored payload is now something the parser understands.
        await prisma.rawResponse.updateMany({
            where: { pullKey: 'overall' },
            data: { payload: JSON.parse(fixtureText('overall.json')) },
        });
        const callsBefore = calls.length;
        const reprocessed = await reprocessRun(makeDeps().deps, first.runId, 'admin@codebasics.io');

        expect(calls.length).toBe(callsBefore);
        expect(reprocessed).toMatchObject({ status: 'SUCCESS', apiCallsUsed: 0, snapshotDate: SNAPSHOT_DATE });
        const run = await prisma.pipelineRun.findUniqueOrThrow({ where: { id: reprocessed.runId } });
        expect(run).toMatchObject({ trigger: 'REPROCESS', reprocessOfRunId: first.runId, apiCallsUsed: 0 });
        expect(await prisma.metricValue.count({ where: { pullKey: 'overall', runId: reprocessed.runId } })).toBeGreaterThan(0);
    });
});

describe('budget guard', () => {
    it('scheduled runs never exceed budget - reserved calls per day', async () => {
        clarity();
        await useCallsToday(6); // e.g. an MCP server used 6 calls today
        const result = await runPipeline(makeDeps().deps, { trigger: 'CRON_CLI', triggeredBy: 'system' });

        expect(result).toMatchObject({ status: 'PARTIAL_SUCCESS', errorCode: 'BUDGET_EXHAUSTED', apiCallsUsed: 2, pullsSkipped: 2 });
        expect(calls).toEqual(['overall', 'device']);
        expect(await prisma.apiCallLog.count({ where: { budgetDate: isoDateToUtc(BUDGET_DATE) } })).toBe(8);
    });

    it('stops retrying when the budget runs out mid-retry', async () => {
        clarity({ overall: () => new HttpResponse(null, { status: 500 }) });
        await useCallsToday(6);
        const result = await runPipeline(makeDeps().deps, { trigger: 'CRON_CLI', triggeredBy: 'system' });
        expect(calls).toEqual(['overall', 'overall']);
        expect(result.apiCallsUsed).toBe(2);
        expect(await prisma.apiCallLog.count()).toBe(8);
    });

    it('confirmed manual runs may use the reserved calls', async () => {
        clarity();
        await useCallsToday(6);
        const result = await runPipeline(makeDeps().deps, {
            trigger: 'MANUAL',
            triggeredBy: 'admin@codebasics.io',
            useReservedCalls: true,
        });
        expect(result).toMatchObject({ status: 'SUCCESS', apiCallsUsed: 4 });
        expect(await prisma.apiCallLog.count()).toBe(10);
    });

    it('the reserved-call flag is ignored for scheduled triggers', async () => {
        clarity();
        await useCallsToday(8);
        const result = await runPipeline(makeDeps().deps, { trigger: 'CRON_HTTP', triggeredBy: 'system', useReservedCalls: true });
        expect(result).toMatchObject({ status: 'FAILED', errorCode: 'BUDGET_EXHAUSTED', apiCallsUsed: 0 });
        expect(calls).toEqual([]);
    });
});

describe('run safety', () => {
    it('SKIPPED_LOCKED: a second trigger while a run holds the lock is recorded and exits', async () => {
        clarity();
        const held = await createPgAdvisoryLock(TEST_DATABASE_URL).tryAcquire();
        try {
            const result = await runPipeline(makeDeps().deps, { trigger: 'CRON_HTTP', triggeredBy: 'system' });
            expect(result.status).toBe('SKIPPED_LOCKED');
            expect(calls).toEqual([]);
            expect(await prisma.pipelineRun.findUniqueOrThrow({ where: { id: result.runId } })).toMatchObject({
                status: 'SKIPPED_LOCKED',
                trigger: 'CRON_HTTP',
            });
        } finally {
            await held?.release();
        }
    });

    it('marks runs stuck in RUNNING for over 30 minutes as FAILED', async () => {
        clarity();
        const stale = await prisma.pipelineRun.create({
            data: {
                trigger: 'CRON_CLI',
                triggeredBy: 'system',
                status: 'RUNNING',
                snapshotDate: isoDateToUtc('2026-11-24'),
                startedAt: new Date(RUN_TIME.getTime() - 45 * 60_000),
            },
        });
        const recent = await prisma.pipelineRun.create({
            data: {
                trigger: 'MANUAL',
                triggeredBy: 'x',
                status: 'RUNNING',
                snapshotDate: isoDateToUtc('2026-11-24'),
                startedAt: new Date(RUN_TIME.getTime() - 5 * 60_000),
            },
        });

        await runPipeline(makeDeps().deps, { trigger: 'CRON_CLI', triggeredBy: 'system' });

        expect(await prisma.pipelineRun.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({
            status: 'FAILED',
            errorCode: 'UNKNOWN',
            errorMessage: STALE_RUN_MESSAGE,
        });
        expect((await prisma.pipelineRun.findUniqueOrThrow({ where: { id: recent.id } })).status).toBe('RUNNING');
    });

    it('releases the lock after a run so the next one can start', async () => {
        clarity();
        await runPipeline(makeDeps().deps, { trigger: 'CRON_CLI', triggeredBy: 'system' });
        const lock = await createPgAdvisoryLock(TEST_DATABASE_URL).tryAcquire();
        expect(lock).not.toBeNull();
        await lock?.release();
    });
});

describe('health', () => {
    it('is unhealthy with no successful run in 26 hours, healthy right after one', async () => {
        const { deps } = makeDeps();
        expect((await checkPipelineHealth(deps.repo, RUN_TIME)).healthy).toBe(false);

        clarity();
        await runPipeline(deps, { trigger: 'CRON_CLI', triggeredBy: 'system' });
        expect((await checkPipelineHealth(deps.repo, new Date(RUN_TIME.getTime() + 25 * 3_600_000))).healthy).toBe(true);
        expect((await checkPipelineHealth(deps.repo, new Date(RUN_TIME.getTime() + 27 * 3_600_000))).healthy).toBe(false);
    });
});
