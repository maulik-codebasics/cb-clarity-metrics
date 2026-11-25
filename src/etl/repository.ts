import { Prisma, type PrismaClient } from '@/generated/prisma/client';
import { ErrorCode, RunStatus, StepStatus, type RunTrigger } from '@/generated/prisma/enums';
import { isoDateToUtc, utcToIsoDate, type IsoDate } from '@/lib/time';
import type { MetricRow } from './flatten';
import { isClarityDimension, type PullDefinition } from './types';

export const STALE_RUN_MESSAGE = 'Run did not complete (process killed or timed out)';

export interface NewRun {
    trigger: RunTrigger;
    triggeredBy: string;
    status: RunStatus;
    snapshotDate: IsoDate;
    numOfDays: number;
    startedAt: Date;
    windowStart?: Date;
    windowEnd?: Date;
    reprocessOfRunId?: string;
}

export interface RunTotals {
    status: RunStatus;
    endedAt: Date;
    durationMs: number;
    pullsTotal: number;
    pullsSucceeded: number;
    pullsFailed: number;
    pullsSkipped: number;
    apiCallsUsed: number;
    rowsFetched: number;
    metricsWritten: number;
    errorCode: ErrorCode | null;
    errorMessage: string | null;
    errorDetails: Prisma.InputJsonValue | null;
}

export interface NewStep {
    runId: string;
    pullKey: string;
    dimensions: string[];
    attempt: number;
    status: StepStatus;
    startedAt: Date;
}

export interface StepResult {
    status: StepStatus;
    httpStatus?: number | null;
    endedAt: Date;
    durationMs: number;
    rowsFetched?: number;
    metricsWritten?: number;
    errorCode?: ErrorCode | null;
    errorMessage?: string | null;
    errorDetails?: Prisma.InputJsonValue | null;
}

export interface StoredRawResponse {
    stepId: string;
    pullKey: string;
    dimensions: string[];
    snapshotDate: IsoDate;
    payload: unknown;
}

const jsonOrNull = (value: Prisma.InputJsonValue | null | undefined) => (value === null || value === undefined ? Prisma.DbNull : value);

/** All database access for the ETL. */
export class EtlRepository {
    constructor(private readonly db: PrismaClient) {}

    /** Mark runs stuck in RUNNING longer than `maxAgeMs` as FAILED. Returns how many. */
    async recoverStaleRuns(now: Date, maxAgeMs: number): Promise<number> {
        const stale = await this.db.pipelineRun.findMany({
            where: { status: RunStatus.RUNNING, startedAt: { lt: new Date(now.getTime() - maxAgeMs) } },
            select: { id: true, startedAt: true },
        });
        for (const run of stale) {
            await this.db.$transaction([
                this.db.pipelineRun.update({
                    where: { id: run.id },
                    data: {
                        status: RunStatus.FAILED,
                        endedAt: now,
                        durationMs: now.getTime() - run.startedAt.getTime(),
                        errorCode: ErrorCode.UNKNOWN,
                        errorMessage: STALE_RUN_MESSAGE,
                    },
                }),
                this.db.pipelineRunStep.updateMany({
                    where: { runId: run.id, status: StepStatus.RUNNING },
                    data: { status: StepStatus.FAILED, endedAt: now, errorCode: ErrorCode.UNKNOWN, errorMessage: STALE_RUN_MESSAGE },
                }),
            ]);
        }
        return stale.length;
    }

    async createRun(run: NewRun): Promise<string> {
        const created = await this.db.pipelineRun.create({
            data: {
                trigger: run.trigger,
                triggeredBy: run.triggeredBy,
                status: run.status,
                snapshotDate: isoDateToUtc(run.snapshotDate),
                numOfDays: run.numOfDays,
                startedAt: run.startedAt,
                windowStart: run.windowStart,
                windowEnd: run.windowEnd,
                reprocessOfRunId: run.reprocessOfRunId,
            },
            select: { id: true },
        });
        return created.id;
    }

    async finishRun(runId: string, totals: RunTotals): Promise<void> {
        await this.db.pipelineRun.update({
            where: { id: runId },
            data: { ...totals, errorDetails: jsonOrNull(totals.errorDetails) },
        });
    }

    /** Enabled pulls in display order, from the DB (seeded from pulls.config.ts). */
    async getEnabledPulls(): Promise<PullDefinition[]> {
        const rows = await this.db.pullConfig.findMany({ where: { enabled: true }, orderBy: { displayOrder: 'asc' } });
        return rows.map((row) => ({
            key: row.key,
            dimensions: row.dimensions.filter(isClarityDimension),
            enabled: row.enabled,
            displayOrder: row.displayOrder,
        }));
    }

    async countCallsOn(budgetDate: IsoDate): Promise<number> {
        return this.db.apiCallLog.count({ where: { budgetDate: isoDateToUtc(budgetDate) } });
    }

    /** Logged before the request is sent, so a crash mid-call still counts against the budget. */
    async logCallStart(entry: { runId: string; stepId: string; calledAt: Date; budgetDate: IsoDate }): Promise<bigint> {
        const created = await this.db.apiCallLog.create({
            data: { runId: entry.runId, stepId: entry.stepId, calledAt: entry.calledAt, budgetDate: isoDateToUtc(entry.budgetDate) },
            select: { id: true },
        });
        return created.id;
    }

    async logCallResult(callId: bigint, httpStatus: number | null): Promise<void> {
        await this.db.apiCallLog.update({ where: { id: callId }, data: { httpStatus } });
    }

    async createStep(step: NewStep): Promise<string> {
        const created = await this.db.pipelineRunStep.create({ data: step, select: { id: true } });
        return created.id;
    }

    async finishStep(stepId: string, result: StepResult): Promise<void> {
        await this.db.pipelineRunStep.update({
            where: { id: stepId },
            data: { ...result, errorDetails: jsonOrNull(result.errorDetails) },
        });
    }

    async saveRawResponse(raw: {
        stepId: string;
        snapshotDate: IsoDate;
        pullKey: string;
        payload: Prisma.InputJsonValue;
        fetchedAt: Date;
    }) {
        await this.db.rawResponse.create({
            data: { ...raw, snapshotDate: isoDateToUtc(raw.snapshotDate) },
        });
    }

    /** Replace one pull's metrics for one snapshot date, atomically. Returns rows written. */
    async replaceMetrics(input: { snapshotDate: IsoDate; pullKey: string; runId: string; rows: MetricRow[] }): Promise<number> {
        const snapshotDate = isoDateToUtc(input.snapshotDate);
        const data = input.rows.map((row) => ({
            snapshotDate,
            pullKey: input.pullKey,
            runId: input.runId,
            metricName: row.metricName,
            field: row.field,
            dim1Name: row.dims[0].name,
            dim1Value: row.dims[0].value,
            dim2Name: row.dims[1].name,
            dim2Value: row.dims[1].value,
            dim3Name: row.dims[2].name,
            dim3Value: row.dims[2].value,
            value: row.value,
        }));
        const [, created] = await this.db.$transaction([
            this.db.metricValue.deleteMany({ where: { snapshotDate, pullKey: input.pullKey } }),
            this.db.metricValue.createMany({ data }),
        ]);
        return created.count;
    }

    async getRun(runId: string) {
        return this.db.pipelineRun.findUnique({ where: { id: runId } });
    }

    /** Latest stored raw response per pull for a run, for reprocessing. */
    async getRawResponsesForRun(runId: string): Promise<StoredRawResponse[]> {
        const raws = await this.db.rawResponse.findMany({
            where: { step: { runId } },
            include: { step: { select: { pullKey: true, dimensions: true } } },
            orderBy: { fetchedAt: 'desc' },
        });
        const latest = new Map<string, StoredRawResponse>();
        for (const raw of raws) {
            if (!latest.has(raw.pullKey)) {
                latest.set(raw.pullKey, {
                    stepId: raw.stepId,
                    pullKey: raw.pullKey,
                    dimensions: raw.step.dimensions,
                    snapshotDate: utcToIsoDate(raw.snapshotDate),
                    payload: raw.payload,
                });
            }
        }
        return [...latest.values()];
    }

    /** End time of the latest run that collected data (SUCCESS or PARTIAL_SUCCESS, not a reprocess). */
    async lastSuccessfulRunAt(): Promise<Date | null> {
        const run = await this.db.pipelineRun.findFirst({
            where: { status: { in: [RunStatus.SUCCESS, RunStatus.PARTIAL_SUCCESS] }, trigger: { not: 'REPROCESS' } },
            orderBy: { startedAt: 'desc' },
            select: { endedAt: true, startedAt: true },
        });
        return run ? (run.endedAt ?? run.startedAt) : null;
    }

    async ping(): Promise<void> {
        await this.db.$queryRaw`SELECT 1`;
    }

    async purgeRawResponses(olderThan: Date): Promise<number> {
        const result = await this.db.rawResponse.deleteMany({ where: { fetchedAt: { lt: olderThan } } });
        return result.count;
    }
}
