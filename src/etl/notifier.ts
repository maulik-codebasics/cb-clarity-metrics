import type { ErrorCode, RunStatus } from '@/generated/prisma/enums';
import type { Logger } from '@/lib/logger';

export interface RunProblem {
    runId: string;
    status: RunStatus;
    snapshotDate: string;
    failedPulls: Array<{ pullKey: string; errorCode: ErrorCode | null; errorMessage: string | null }>;
    remainingCallsToday: number;
}

export interface HealthProblem {
    lastSuccessAt: Date | null;
    hoursSinceSuccess: number | null;
}

/** Sends alerts. Teams and email implementations come with the alerts milestone. */
export interface Notifier {
    notifyRunProblem(problem: RunProblem): Promise<void>;
    notifyHealthProblem(problem: HealthProblem): Promise<void>;
}

/** Writes alerts to the log only. Used until a Teams/email notifier is configured. */
export function createLogNotifier(logger: Logger): Notifier {
    return {
        async notifyRunProblem(problem) {
            logger.warn({ alert: 'run_problem', ...problem }, `ETL run ${problem.status}`);
        },
        async notifyHealthProblem(problem) {
            logger.warn({ alert: 'health_problem', ...problem }, 'No successful ETL run in the last 26 hours');
        },
    };
}
