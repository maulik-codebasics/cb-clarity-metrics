import { ErrorCode, RunStatus, RunTrigger, StepStatus } from '@/generated/prisma/enums';
import { utcToIsoDate } from '@/lib/time';
import { FlattenError, flattenClarityResponse } from './flatten';
import { runStatusFor, type PipelineDeps, type RunResult } from './run-pipeline';

export class ReprocessError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ReprocessError';
    }
}

/**
 * Re-parse a run's stored raw responses and replace their metrics, without
 * calling Clarity. Recorded as a new run (trigger REPROCESS, 0 API calls).
 */
export async function reprocessRun(
    deps: Pick<PipelineDeps, 'repo' | 'lock' | 'config' | 'logger' | 'clock'>,
    originalRunId: string,
    triggeredBy: string,
): Promise<RunResult> {
    const clock = deps.clock ?? (() => new Date());
    const { repo, config } = deps;

    const original = await repo.getRun(originalRunId);
    if (!original) {
        throw new ReprocessError(`Run ${originalRunId} not found`);
    }
    const raws = await repo.getRawResponsesForRun(originalRunId);
    if (raws.length === 0) {
        throw new ReprocessError(`Run ${originalRunId} has no stored raw responses (purged, or no successful API call)`);
    }

    const lock = await deps.lock.tryAcquire();
    if (!lock) {
        throw new ReprocessError('Another run is in progress; try again when it finishes');
    }
    const startedAt = clock();
    const snapshotDate = utcToIsoDate(original.snapshotDate);
    try {
        const runId = await repo.createRun({
            trigger: RunTrigger.REPROCESS,
            triggeredBy,
            status: RunStatus.RUNNING,
            snapshotDate,
            numOfDays: original.numOfDays,
            startedAt,
            windowStart: original.windowStart ?? undefined,
            windowEnd: original.windowEnd ?? undefined,
            reprocessOfRunId: originalRunId,
        });
        const logger = deps.logger.child({ runId, reprocessOf: originalRunId });

        let succeeded = 0;
        let rowsFetched = 0;
        let metricsWritten = 0;
        const failures: Array<{ pullKey: string; errorCode: ErrorCode; errorMessage: string }> = [];

        for (const raw of raws) {
            const stepStartedAt = clock();
            const stepId = await repo.createStep({
                runId,
                pullKey: raw.pullKey,
                dimensions: raw.dimensions,
                attempt: 1,
                status: StepStatus.RUNNING,
                startedAt: stepStartedAt,
            });
            let errorCode: ErrorCode | null = null;
            let errorMessage: string | null = null;
            let rows = 0;
            let written = 0;
            try {
                const flattened = flattenClarityResponse(raw.payload, {
                    requestedDimensions: raw.dimensions,
                    stripUrlQuery: config.stripUrlQuery,
                });
                rows = flattened.itemCount;
                flattened.warnings.slice(0, 50).forEach((w) => logger.warn({ pullKey: raw.pullKey }, `Parser: ${w}`));
                try {
                    written = await repo.replaceMetrics({
                        snapshotDate: raw.snapshotDate,
                        pullKey: raw.pullKey,
                        runId,
                        rows: flattened.rows,
                    });
                } catch (error) {
                    errorCode = ErrorCode.DB_ERROR;
                    errorMessage = `Could not write metrics: ${error instanceof Error ? error.message : String(error)}`;
                }
            } catch (error) {
                errorCode = ErrorCode.PARSE_ERROR;
                errorMessage = error instanceof FlattenError ? error.message : `Parser crashed: ${String(error)}`;
            }
            const endedAt = clock();
            await repo.finishStep(stepId, {
                status: errorCode ? StepStatus.FAILED : StepStatus.SUCCESS,
                endedAt,
                durationMs: endedAt.getTime() - stepStartedAt.getTime(),
                rowsFetched: rows,
                metricsWritten: written,
                errorCode,
                errorMessage,
            });
            if (errorCode && errorMessage) {
                failures.push({ pullKey: raw.pullKey, errorCode, errorMessage });
            } else {
                succeeded += 1;
                rowsFetched += rows;
                metricsWritten += written;
            }
        }

        const endedAt = clock();
        const status = runStatusFor(raws.length, succeeded);
        const errorCode = failures[0]?.errorCode ?? null;
        const errorMessage =
            failures.length > 0 ? failures.map((f) => `${f.pullKey}: ${f.errorCode} – ${f.errorMessage}`).join('; ') : null;
        await repo.finishRun(runId, {
            status,
            endedAt,
            durationMs: endedAt.getTime() - startedAt.getTime(),
            pullsTotal: raws.length,
            pullsSucceeded: succeeded,
            pullsFailed: failures.length,
            pullsSkipped: 0,
            apiCallsUsed: 0,
            rowsFetched,
            metricsWritten,
            errorCode,
            errorMessage,
            errorDetails: failures.length > 0 ? { failures } : null,
        });
        logger.info({ status, succeeded, failed: failures.length }, 'Reprocess finished');
        return {
            runId,
            status,
            snapshotDate,
            apiCallsUsed: 0,
            pullsSucceeded: succeeded,
            pullsFailed: failures.length,
            pullsSkipped: 0,
            errorCode,
            errorMessage,
        };
    } finally {
        await lock.release();
    }
}
