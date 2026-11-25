/**
 * npm run etl:reprocess -- --runId=<uuid> [--by=EMAIL]
 * Re-parses a run's stored raw responses. Costs no API calls.
 */
import { parseArgs } from 'node:util';
import { RunStatus } from '@/generated/prisma/enums';
import { ReprocessError, reprocessRun } from '@/etl/reprocess';
import { runCli } from './cli';

const { values } = parseArgs({
    options: {
        runId: { type: 'string' },
        by: { type: 'string', default: 'cli' },
    },
});

void runCli(async ({ deps, logger }) => {
    if (!values.runId) {
        console.error('Usage: npm run etl:reprocess -- --runId=<uuid>');
        return 64; // EX_USAGE
    }
    try {
        const result = await reprocessRun(deps, values.runId, values.by);
        logger.info({ result }, 'etl:reprocess done');
        return result.status === RunStatus.SUCCESS ? 0 : 1;
    } catch (error) {
        if (error instanceof ReprocessError) {
            console.error(error.message);
            return 1;
        }
        throw error;
    }
});
