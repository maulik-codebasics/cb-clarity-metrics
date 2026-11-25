import type { EtlRepository } from './repository';

export const HEALTH_MAX_HOURS_WITHOUT_SUCCESS = 26;

export interface PipelineHealth {
    healthy: boolean;
    database: 'ok' | 'error';
    lastSuccessAt: Date | null;
    hoursSinceSuccess: number | null;
}

/** Healthy = DB reachable and a run collected data within the last 26 hours. */
export async function checkPipelineHealth(
    repo: Pick<EtlRepository, 'ping' | 'lastSuccessfulRunAt'>,
    now: Date,
    maxHours: number = HEALTH_MAX_HOURS_WITHOUT_SUCCESS,
): Promise<PipelineHealth> {
    try {
        await repo.ping();
    } catch {
        return { healthy: false, database: 'error', lastSuccessAt: null, hoursSinceSuccess: null };
    }
    const lastSuccessAt = await repo.lastSuccessfulRunAt();
    const hoursSinceSuccess = lastSuccessAt ? (now.getTime() - lastSuccessAt.getTime()) / 3_600_000 : null;
    return {
        healthy: hoursSinceSuccess !== null && hoursSinceSuccess <= maxHours,
        database: 'ok',
        lastSuccessAt,
        hoursSinceSuccess: hoursSinceSuccess === null ? null : Math.round(hoursSinceSuccess * 10) / 10,
    };
}
