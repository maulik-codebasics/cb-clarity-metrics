/**
 * npm run etl:health
 * Exit 0 if a run collected data in the last 26 hours, else alert and exit 1.
 */
import { checkPipelineHealth } from '@/etl/health';
import { runCli } from './cli';

void runCli(async ({ deps }) => {
    const health = await checkPipelineHealth(deps.repo, new Date());
    console.log(JSON.stringify(health));
    if (!health.healthy) {
        await deps.notifier?.notifyHealthProblem({
            lastSuccessAt: health.lastSuccessAt,
            hoursSinceSuccess: health.hoursSinceSuccess,
        });
        return 1;
    }
    return 0;
});
