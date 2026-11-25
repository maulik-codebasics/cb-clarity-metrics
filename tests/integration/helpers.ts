import pino from 'pino';
import { vi } from 'vitest';
import { createHttpClarityClient } from '@/etl/clarity-client';
import { createPgAdvisoryLock } from '@/etl/lock';
import type { Notifier } from '@/etl/notifier';
import { DEFAULT_PULLS } from '@/etl/pulls.config';
import { EtlRepository } from '@/etl/repository';
import { DEFAULT_PIPELINE_CONFIG, type PipelineDeps } from '@/etl/run-pipeline';
import { createPrismaClient } from '@/lib/db';
import { isoDateToUtc } from '@/lib/time';
import { TEST_DATABASE_URL } from './test-db-url';

export const TOKEN = 'test-token-do-not-leak';
export const prisma = createPrismaClient(TEST_DATABASE_URL);

/** 2026-11-26 00:30 IST: snapshot date 2026-11-25, budget day 2026-11-26. */
export const RUN_TIME = new Date('2026-11-25T19:00:00.000Z');
export const SNAPSHOT_DATE = '2026-11-25';
export const BUDGET_DATE = '2026-11-26';

export async function resetDatabase(): Promise<void> {
    await prisma.$executeRawUnsafe(
        'TRUNCATE pipeline_runs, pipeline_run_steps, raw_responses, metric_values, api_call_log, pull_configs, kpi_definitions RESTART IDENTITY CASCADE',
    );
    await prisma.pullConfig.createMany({ data: DEFAULT_PULLS.map((p) => ({ ...p, dimensions: [...p.dimensions] })) });
}

/** Pretend other tools already used `count` calls today. */
export async function useCallsToday(count: number): Promise<void> {
    await prisma.apiCallLog.createMany({
        data: Array.from({ length: count }, () => ({ budgetDate: isoDateToUtc(BUDGET_DATE), calledAt: RUN_TIME, httpStatus: 200 })),
    });
}

export function makeDeps(overrides: Partial<PipelineDeps> = {}) {
    let tick = 0;
    const notifier: Notifier = { notifyRunProblem: vi.fn(async () => undefined), notifyHealthProblem: vi.fn(async () => undefined) };
    const sleep = vi.fn(async () => undefined);
    const deps: PipelineDeps = {
        repo: new EtlRepository(prisma),
        client: createHttpClarityClient({ token: TOKEN }),
        lock: createPgAdvisoryLock(TEST_DATABASE_URL),
        logger: pino({ level: 'silent' }),
        notifier,
        // Each read advances 100ms so durations are non-zero and ordered.
        clock: () => new Date(RUN_TIME.getTime() + 100 * tick++),
        sleep,
        config: {
            ...DEFAULT_PIPELINE_CONFIG,
            timeZone: 'Asia/Kolkata',
            budget: { dailyBudget: 10, reserved: 2 },
            budgetResetOffsetMinutes: 0,
            stripUrlQuery: true,
            secrets: [TOKEN],
        },
        ...overrides,
    };
    return { deps, notifier, sleep };
}
