/**
 * npm run etl:run                         scheduled run (cron), never touches reserved calls
 * npm run etl:run -- --manual --by=EMAIL  manual late run; passing --manual confirms use of reserved calls
 *
 * Exit codes: 0 SUCCESS or SKIPPED_LOCKED, 2 PARTIAL_SUCCESS, 1 FAILED.
 */
import { parseArgs } from 'node:util';
import { RunStatus, RunTrigger } from '@/generated/prisma/enums';
import { runPipeline } from '@/etl/run-pipeline';
import { runCli } from './cli';

const { values } = parseArgs({
    options: {
        manual: { type: 'boolean', default: false },
        by: { type: 'string' },
    },
});

void runCli(async ({ deps, logger }) => {
    const result = await runPipeline(deps, {
        trigger: values.manual ? RunTrigger.MANUAL : RunTrigger.CRON_CLI,
        triggeredBy: values.manual ? (values.by ?? 'cli') : 'system',
        useReservedCalls: values.manual,
    });
    logger.info({ result }, 'etl:run done');
    if (result.status === RunStatus.FAILED) {
        return 1;
    }
    return result.status === RunStatus.PARTIAL_SUCCESS ? 2 : 0;
});
