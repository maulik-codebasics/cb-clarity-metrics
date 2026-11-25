/**
 * npm run etl:purge-raw [-- --days=N]
 * Deletes raw responses older than RAW_RETENTION_DAYS (default 180). Metrics are kept forever.
 */
import { parseArgs } from 'node:util';
import { runCli } from './cli';

const { values } = parseArgs({ options: { days: { type: 'string' } } });

void runCli(async ({ deps, env, logger }) => {
    const days = values.days ? Number(values.days) : env.RAW_RETENTION_DAYS;
    if (!Number.isInteger(days) || days < 1) {
        console.error('--days must be a positive integer');
        return 64;
    }
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const deleted = await deps.repo.purgeRawResponses(cutoff);
    logger.info({ deleted, olderThan: cutoff.toISOString(), days }, 'etl:purge-raw done');
    return 0;
});
