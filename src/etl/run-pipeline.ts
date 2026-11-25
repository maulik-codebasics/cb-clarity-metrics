import type { Prisma } from '@/generated/prisma/client';
import { ErrorCode, RunStatus, RunTrigger, StepStatus } from '@/generated/prisma/enums';
import type { Logger } from '@/lib/logger';
import { redactText } from '@/lib/redact';
import { type IsoDate } from '@/lib/time';
import { callLimit, canMakeCall, remainingCalls, type BudgetPolicy } from './budget';
import type { ClarityClient, ClarityResponse } from './clarity-client';
import { classifyHttpStatus, classifyThrown, type FailureClass } from './classify-error';
import { FlattenError, flattenClarityResponse } from './flatten';
import type { LockProvider } from './lock';
import type { Notifier } from './notifier';
import { NUM_OF_DAYS } from './pulls.config';
import type { EtlRepository } from './repository';
import { budgetDateFor, dataWindowFor, snapshotDateFor } from './snapshot-date';
import type { PullDefinition } from './types';

export interface PipelineConfig {
    timeZone: string;
    budget: BudgetPolicy;
    budgetResetOffsetMinutes: number;
    stripUrlQuery: boolean;
    /** Retries after the first attempt, for network errors and 5xx. */
    maxRetries: number;
    backoffBaseMs: number;
    staleRunMaxAgeMs: number;
    /** Values scrubbed from anything stored or logged (the API token). */
    secrets: string[];
}

export const DEFAULT_PIPELINE_CONFIG: Omit<
    PipelineConfig,
    'timeZone' | 'budget' | 'budgetResetOffsetMinutes' | 'stripUrlQuery' | 'secrets'
> = {
    maxRetries: 2,
    backoffBaseMs: 2000,
    staleRunMaxAgeMs: 30 * 60 * 1000,
};

export interface PipelineDeps {
    repo: EtlRepository;
    client: ClarityClient;
    lock: LockProvider;
    config: PipelineConfig;
    logger: Logger;
    notifier?: Notifier;
    clock?: () => Date;
    sleep?: (ms: number) => Promise<void>;
}

export interface RunOptions {
    trigger: Exclude<RunTrigger, 'REPROCESS'>;
    triggeredBy: string;
    /** Manual runs only, after the user confirmed: allow the reserved calls. */
    useReservedCalls?: boolean;
    /** Called as soon as the run row exists (the HTTP trigger returns 202 with this id). */
    onRunCreated?: (runId: string) => void;
}

export interface RunResult {
    runId: string;
    status: RunStatus;
    snapshotDate: IsoDate;
    apiCallsUsed: number;
    pullsSucceeded: number;
    pullsFailed: number;
    pullsSkipped: number;
    errorCode: ErrorCode | null;
    errorMessage: string | null;
}

/** Outcome of one pull across all of its attempts. */
interface PullOutcome {
    pullKey: string;
    status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
    errorCode: ErrorCode | null;
    errorMessage: string | null;
    callsUsed: number;
    rowsFetched: number;
    metricsWritten: number;
    /** Stop calling Clarity for the remaining pulls of this run. */
    stopRemaining: ErrorCode | null;
}

const RESPONSE_SNIPPET_LENGTH = 500;
const MAX_LOGGED_WARNINGS = 50;
const STOP_REMAINING_CODES: ReadonlySet<ErrorCode> = new Set([ErrorCode.RATE_LIMITED, ErrorCode.BUDGET_EXHAUSTED]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function isDbError(error: unknown): boolean {
    return error instanceof Error && /^Prisma|DriverAdapterError/.test(error.name);
}

/** Final run status from pull counts. */
export function runStatusFor(total: number, succeeded: number): RunStatus {
    if (total > 0 && succeeded === total) {
        return RunStatus.SUCCESS;
    }
    return succeeded === 0 ? RunStatus.FAILED : RunStatus.PARTIAL_SUCCESS;
}

/**
 * Run the ETL once: lock, recover stale runs, call Clarity for each enabled
 * pull (respecting the daily budget), store raw JSON, flatten, replace metrics.
 */
export async function runPipeline(deps: PipelineDeps, options: RunOptions): Promise<RunResult> {
    const clock = deps.clock ?? (() => new Date());
    const { repo, config } = deps;
    const startedAt = clock();
    const snapshotDate = snapshotDateFor(startedAt, config.timeZone);
    const useReserved = options.trigger === RunTrigger.MANUAL && options.useReservedCalls === true;

    const lock = await deps.lock.tryAcquire();
    if (!lock) {
        const runId = await repo.createRun({
            trigger: options.trigger,
            triggeredBy: options.triggeredBy,
            status: RunStatus.SKIPPED_LOCKED,
            snapshotDate,
            numOfDays: NUM_OF_DAYS,
            startedAt,
        });
        await repo.finishRun(runId, {
            ...emptyTotals(RunStatus.SKIPPED_LOCKED, clock(), startedAt),
            errorMessage: 'Another run was in progress',
        });
        options.onRunCreated?.(runId);
        deps.logger.info({ runId }, 'ETL run skipped: another run holds the lock');
        return { ...emptyResult(runId, RunStatus.SKIPPED_LOCKED, snapshotDate), errorMessage: 'Another run was in progress' };
    }

    let runId: string | undefined;
    try {
        const recovered = await repo.recoverStaleRuns(startedAt, config.staleRunMaxAgeMs);
        const window = dataWindowFor(startedAt, NUM_OF_DAYS);
        runId = await repo.createRun({
            trigger: options.trigger,
            triggeredBy: options.triggeredBy,
            status: RunStatus.RUNNING,
            snapshotDate,
            numOfDays: NUM_OF_DAYS,
            startedAt,
            windowStart: window.start,
            windowEnd: window.end,
        });
        options.onRunCreated?.(runId);
        const logger = deps.logger.child({ runId });
        logger.info({ snapshotDate, trigger: options.trigger, useReserved, recoveredStaleRuns: recovered }, 'ETL run started');

        const pulls = await repo.getEnabledPulls();
        const outcomes: PullOutcome[] = [];
        let stopCode: ErrorCode | null = null;
        for (const pull of pulls) {
            if (stopCode) {
                outcomes.push(await recordSkippedPull(deps, runId, pull, stopCode, clock()));
                continue;
            }
            const outcome = await processPull({ deps, logger, runId, pull, snapshotDate, useReserved, clock });
            outcomes.push(outcome);
            stopCode = outcome.stopRemaining;
        }

        const endedAt = clock();
        const succeeded = outcomes.filter((o) => o.status === 'SUCCESS').length;
        const failed = outcomes.filter((o) => o.status === 'FAILED').length;
        const skipped = outcomes.filter((o) => o.status === 'SKIPPED').length;
        const status = runStatusFor(pulls.length, succeeded);
        const problems = outcomes.filter((o) => o.status !== 'SUCCESS');
        const errorCode = pulls.length === 0 ? ErrorCode.UNKNOWN : (problems[0]?.errorCode ?? null);
        const errorMessage =
            pulls.length === 0
                ? 'No pulls are enabled'
                : problems.length > 0
                  ? problems.map((p) => `${p.pullKey}: ${p.errorCode ?? 'UNKNOWN'} – ${p.errorMessage ?? ''}`).join('; ')
                  : null;
        const apiCallsUsed = outcomes.reduce((sum, o) => sum + o.callsUsed, 0);

        await repo.finishRun(runId, {
            status,
            endedAt,
            durationMs: endedAt.getTime() - startedAt.getTime(),
            pullsTotal: pulls.length,
            pullsSucceeded: succeeded,
            pullsFailed: failed,
            pullsSkipped: skipped,
            apiCallsUsed,
            rowsFetched: outcomes.reduce((sum, o) => sum + o.rowsFetched, 0),
            metricsWritten: outcomes.reduce((sum, o) => sum + o.metricsWritten, 0),
            errorCode,
            errorMessage,
            errorDetails:
                problems.length > 0
                    ? {
                          failures: problems.map((p) => ({
                              pullKey: p.pullKey,
                              status: p.status,
                              errorCode: p.errorCode,
                              errorMessage: p.errorMessage,
                          })),
                      }
                    : null,
        });
        logger.info({ status, apiCallsUsed, succeeded, failed, skipped }, 'ETL run finished');

        if (status !== RunStatus.SUCCESS) {
            await notify(deps, logger, {
                runId,
                status,
                snapshotDate,
                failedPulls: problems.map((p) => ({ pullKey: p.pullKey, errorCode: p.errorCode, errorMessage: p.errorMessage })),
                remainingCallsToday: remainingCalls(
                    await repo.countCallsOn(budgetDateFor(clock(), config.timeZone, config.budgetResetOffsetMinutes)),
                    config.budget,
                    true,
                ),
            });
        }

        return {
            runId,
            status,
            snapshotDate,
            apiCallsUsed,
            pullsSucceeded: succeeded,
            pullsFailed: failed,
            pullsSkipped: skipped,
            errorCode,
            errorMessage,
        };
    } catch (error) {
        const errorCode = isDbError(error) ? ErrorCode.DB_ERROR : ErrorCode.UNKNOWN;
        const errorMessage = redactText(error instanceof Error ? error.message : String(error), config.secrets);
        deps.logger.error({ runId, errorCode, err: errorMessage }, 'ETL run crashed');
        if (runId) {
            await repo
                .finishRun(runId, {
                    ...emptyTotals(RunStatus.FAILED, clock(), startedAt),
                    errorCode,
                    errorMessage,
                    errorDetails: { stack: redactText(error instanceof Error ? (error.stack ?? '') : '', config.secrets) },
                })
                .catch((finishError: unknown) => deps.logger.error({ runId, err: String(finishError) }, 'Could not record run failure'));
            await notify(deps, deps.logger, {
                runId,
                status: RunStatus.FAILED,
                snapshotDate,
                failedPulls: [{ pullKey: '(run)', errorCode, errorMessage }],
                remainingCallsToday: 0,
            });
            return { ...emptyResult(runId, RunStatus.FAILED, snapshotDate), errorCode, errorMessage };
        }
        throw error;
    } finally {
        await lock.release().catch((error: unknown) => deps.logger.error({ runId, err: String(error) }, 'Could not release ETL lock'));
    }
}

interface PullContext {
    deps: PipelineDeps;
    logger: Logger;
    runId: string;
    pull: PullDefinition;
    snapshotDate: IsoDate;
    useReserved: boolean;
    clock: () => Date;
}

async function processPull(ctx: PullContext): Promise<PullOutcome> {
    const { deps, logger, runId, pull, useReserved, clock } = ctx;
    const { repo, config } = deps;
    const sleep = deps.sleep ?? defaultSleep;
    const outcome: PullOutcome = {
        pullKey: pull.key,
        status: 'FAILED',
        errorCode: null,
        errorMessage: null,
        callsUsed: 0,
        rowsFetched: 0,
        metricsWritten: 0,
        stopRemaining: null,
    };

    for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
        const budgetDate = budgetDateFor(clock(), config.timeZone, config.budgetResetOffsetMinutes);
        const used = await repo.countCallsOn(budgetDate);
        if (!canMakeCall(used, config.budget, useReserved)) {
            const message = `Daily API budget reached (${used} of ${callLimit(config.budget, useReserved)} calls used${useReserved ? '' : ', reserved calls kept free'})`;
            logger.warn({ pullKey: pull.key, used }, message);
            if (attempt === 1) {
                const skipped = await recordSkippedPull(deps, runId, pull, ErrorCode.BUDGET_EXHAUSTED, clock(), message);
                return { ...skipped, stopRemaining: ErrorCode.BUDGET_EXHAUSTED };
            }
            return { ...outcome, stopRemaining: ErrorCode.BUDGET_EXHAUSTED };
        }

        const stepStartedAt = clock();
        const stepId = await repo.createStep({
            runId,
            pullKey: pull.key,
            dimensions: pull.dimensions,
            attempt,
            status: StepStatus.RUNNING,
            startedAt: stepStartedAt,
        });
        const callId = await repo.logCallStart({ runId, stepId, calledAt: stepStartedAt, budgetDate });
        outcome.callsUsed += 1;

        let response: ClarityResponse | null = null;
        let failure: FailureClass | null = null;
        let thrown: unknown = null;
        try {
            response = await deps.client.fetchLiveInsights({ numOfDays: NUM_OF_DAYS, dimensions: pull.dimensions });
        } catch (error) {
            thrown = error;
            failure = classifyThrown(error);
        }
        await repo.logCallResult(callId, response?.status ?? null);
        failure = failure ?? (response ? classifyHttpStatus(response.status) : null);

        if (response && !failure) {
            return handleSuccessfulResponse(ctx, outcome, stepId, stepStartedAt, response);
        }

        const endedAt = clock();
        const failureClass = failure ?? classifyThrown(thrown);
        const message = redactText(failureClass.message, config.secrets);
        await repo.finishStep(stepId, {
            status: StepStatus.FAILED,
            httpStatus: response?.status ?? null,
            endedAt,
            durationMs: endedAt.getTime() - stepStartedAt.getTime(),
            errorCode: failureClass.code,
            errorMessage: message,
            errorDetails: errorDetails(config.secrets, response, thrown),
        });
        logger.warn({ pullKey: pull.key, attempt, httpStatus: response?.status, errorCode: failureClass.code }, message);
        outcome.errorCode = failureClass.code;
        outcome.errorMessage = message;

        if (!failureClass.retryable || attempt > config.maxRetries) {
            outcome.stopRemaining = STOP_REMAINING_CODES.has(failureClass.code) ? failureClass.code : null;
            return outcome;
        }
        await sleep(config.backoffBaseMs * 2 ** (attempt - 1));
    }
    return outcome;
}

async function handleSuccessfulResponse(
    ctx: PullContext,
    outcome: PullOutcome,
    stepId: string,
    stepStartedAt: Date,
    response: ClarityResponse,
): Promise<PullOutcome> {
    const { deps, logger, runId, pull, snapshotDate, clock } = ctx;
    const { repo, config } = deps;
    const finish = async (result: { status: StepStatus; code?: ErrorCode; message?: string; rows?: number; metrics?: number }) => {
        const endedAt = clock();
        await repo.finishStep(stepId, {
            status: result.status,
            httpStatus: response.status,
            endedAt,
            durationMs: endedAt.getTime() - stepStartedAt.getTime(),
            rowsFetched: result.rows ?? 0,
            metricsWritten: result.metrics ?? 0,
            errorCode: result.code ?? null,
            errorMessage: result.message ?? null,
        });
    };
    const fail = async (code: ErrorCode, message: string, rows = 0): Promise<PullOutcome> => {
        logger.error({ pullKey: pull.key, errorCode: code }, message);
        await finish({ status: StepStatus.FAILED, code, message, rows });
        return { ...outcome, status: 'FAILED', errorCode: code, errorMessage: message, rowsFetched: rows };
    };

    // 1. Store the raw response first, so a parse failure can be reprocessed without a new API call.
    let payload: Prisma.InputJsonValue;
    let invalidJson = false;
    try {
        payload = JSON.parse(response.bodyText) as Prisma.InputJsonValue;
    } catch {
        payload = { invalidJson: redactText(response.bodyText.slice(0, 1_000_000), config.secrets) };
        invalidJson = true;
    }
    try {
        await repo.saveRawResponse({ stepId, snapshotDate, pullKey: pull.key, payload, fetchedAt: clock() });
    } catch (error) {
        return fail(ErrorCode.DB_ERROR, `Could not store raw response: ${String(error instanceof Error ? error.message : error)}`);
    }
    if (invalidJson) {
        return fail(ErrorCode.PARSE_ERROR, 'Clarity response is not valid JSON');
    }

    // 2. Flatten.
    let flattened;
    try {
        flattened = flattenClarityResponse(payload, { requestedDimensions: pull.dimensions, stripUrlQuery: config.stripUrlQuery });
    } catch (error) {
        const message = error instanceof FlattenError ? error.message : `Parser crashed: ${String(error)}`;
        return fail(ErrorCode.PARSE_ERROR, message);
    }
    for (const warning of flattened.warnings.slice(0, MAX_LOGGED_WARNINGS)) {
        logger.warn({ pullKey: pull.key }, `Parser: ${warning}`);
    }
    if (flattened.warnings.length > MAX_LOGGED_WARNINGS) {
        logger.warn({ pullKey: pull.key }, `Parser: ${flattened.warnings.length - MAX_LOGGED_WARNINGS} more warnings not logged`);
    }

    // 3. Replace this pull's metrics for the snapshot date.
    let written: number;
    try {
        written = await repo.replaceMetrics({ snapshotDate, pullKey: pull.key, runId, rows: flattened.rows });
    } catch (error) {
        return fail(
            ErrorCode.DB_ERROR,
            `Could not write metrics: ${String(error instanceof Error ? error.message : error)}`,
            flattened.itemCount,
        );
    }

    await finish({ status: StepStatus.SUCCESS, rows: flattened.itemCount, metrics: written });
    logger.info({ pullKey: pull.key, rowsFetched: flattened.itemCount, metricsWritten: written }, 'Pull succeeded');
    return {
        ...outcome,
        status: 'SUCCESS',
        errorCode: null,
        errorMessage: null,
        rowsFetched: flattened.itemCount,
        metricsWritten: written,
    };
}

async function recordSkippedPull(
    deps: PipelineDeps,
    runId: string,
    pull: PullDefinition,
    code: ErrorCode,
    now: Date,
    message = code === ErrorCode.RATE_LIMITED
        ? 'Skipped: Clarity returned 429 for an earlier pull in this run'
        : 'Skipped: daily API budget reached',
): Promise<PullOutcome> {
    const stepId = await deps.repo.createStep({
        runId,
        pullKey: pull.key,
        dimensions: pull.dimensions,
        attempt: 1,
        status: StepStatus.SKIPPED_BUDGET,
        startedAt: now,
    });
    await deps.repo.finishStep(stepId, {
        status: StepStatus.SKIPPED_BUDGET,
        endedAt: now,
        durationMs: 0,
        errorCode: code,
        errorMessage: message,
    });
    return {
        pullKey: pull.key,
        status: 'SKIPPED',
        errorCode: code,
        errorMessage: message,
        callsUsed: 0,
        rowsFetched: 0,
        metricsWritten: 0,
        stopRemaining: code,
    };
}

function errorDetails(secrets: string[], response: ClarityResponse | null, thrown: unknown): Prisma.InputJsonValue {
    const details: Record<string, Prisma.InputJsonValue> = {};
    if (response) {
        details.httpStatus = response.status;
        details.responseSnippet = redactText(response.bodyText.slice(0, RESPONSE_SNIPPET_LENGTH), secrets);
    }
    if (thrown instanceof Error) {
        details.error = redactText(`${thrown.name}: ${thrown.message}`, secrets);
        details.stack = redactText(thrown.stack ?? '', secrets);
    }
    return details;
}

async function notify(deps: PipelineDeps, logger: Logger, problem: Parameters<Notifier['notifyRunProblem']>[0]): Promise<void> {
    if (!deps.notifier) {
        return;
    }
    try {
        await deps.notifier.notifyRunProblem(problem);
    } catch (error) {
        logger.error({ err: String(error) }, 'Could not send alert');
    }
}

function emptyTotals(status: RunStatus, endedAt: Date, startedAt: Date) {
    return {
        status,
        endedAt,
        durationMs: endedAt.getTime() - startedAt.getTime(),
        pullsTotal: 0,
        pullsSucceeded: 0,
        pullsFailed: 0,
        pullsSkipped: 0,
        apiCallsUsed: 0,
        rowsFetched: 0,
        metricsWritten: 0,
        errorCode: null,
        errorMessage: null,
        errorDetails: null,
    };
}

function emptyResult(runId: string, status: RunStatus, snapshotDate: IsoDate): RunResult {
    return {
        runId,
        status,
        snapshotDate,
        apiCallsUsed: 0,
        pullsSucceeded: 0,
        pullsFailed: 0,
        pullsSkipped: 0,
        errorCode: null,
        errorMessage: null,
    };
}
