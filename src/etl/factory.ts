import path from 'node:path';
import { createPrismaClient, type PrismaClient } from '@/lib/db';
import { getEtlEnv, type EtlEnv } from '@/lib/env';
import { createLogger, type Logger } from '@/lib/logger';
import { createFixtureClarityClient, createHttpClarityClient, type ClarityClient } from './clarity-client';
import { createPgAdvisoryLock } from './lock';
import { createLogNotifier } from './notifier';
import { EtlRepository } from './repository';
import { DEFAULT_PIPELINE_CONFIG, type PipelineDeps } from './run-pipeline';

export interface EtlContext {
    env: EtlEnv;
    prisma: PrismaClient;
    deps: PipelineDeps;
    logger: Logger;
    close(): Promise<void>;
}

export const FIXTURES_DIR = path.join(process.cwd(), 'fixtures', 'clarity');

/** Wire the real dependencies from environment variables (used by CLI scripts and API routes). */
export function createEtlContext(env: EtlEnv = getEtlEnv()): EtlContext {
    const logger = createLogger(env.LOG_LEVEL);
    const prisma = createPrismaClient(env.DATABASE_URL);
    let client: ClarityClient;
    if (env.CLARITY_MOCK) {
        logger.warn('CLARITY_MOCK=true: serving fixture data, Clarity will not be called');
        client = createFixtureClarityClient(FIXTURES_DIR);
    } else {
        client = createHttpClarityClient({ token: env.CLARITY_API_TOKEN ?? '' });
    }
    const deps: PipelineDeps = {
        repo: new EtlRepository(prisma),
        client,
        lock: createPgAdvisoryLock(env.DATABASE_URL),
        logger,
        notifier: createLogNotifier(logger),
        config: {
            ...DEFAULT_PIPELINE_CONFIG,
            timeZone: env.APP_TIMEZONE,
            budget: { dailyBudget: env.CLARITY_DAILY_CALL_BUDGET, reserved: env.CLARITY_RESERVED_CALLS },
            budgetResetOffsetMinutes: env.CLARITY_BUDGET_RESET_OFFSET_MINUTES,
            stripUrlQuery: env.STRIP_URL_QUERY,
            secrets: env.CLARITY_API_TOKEN ? [env.CLARITY_API_TOKEN] : [],
        },
    };
    return { env, prisma, deps, logger, close: () => prisma.$disconnect() };
}
