import { ErrorCode } from '@/generated/prisma/enums';
import { ClarityNetworkError, ClarityTimeoutError } from './clarity-client';

export interface FailureClass {
    code: ErrorCode;
    /** Retry with backoff (each retry costs an API call). */
    retryable: boolean;
    message: string;
}

/** Classify a non-2xx HTTP status. Returns null for 2xx. */
export function classifyHttpStatus(status: number): FailureClass | null {
    if (status >= 200 && status < 300) {
        return null;
    }
    if (status === 429) {
        return { code: ErrorCode.RATE_LIMITED, retryable: false, message: 'Clarity daily request limit reached (HTTP 429)' };
    }
    if (status === 401 || status === 403) {
        return {
            code: ErrorCode.AUTH_ERROR,
            retryable: false,
            message: `Clarity rejected the API token (HTTP ${status}). Check CLARITY_API_TOKEN.`,
        };
    }
    if (status === 400) {
        return { code: ErrorCode.BAD_REQUEST, retryable: false, message: 'Clarity rejected the request parameters (HTTP 400)' };
    }
    if (status >= 500) {
        return { code: ErrorCode.SERVER_ERROR, retryable: true, message: `Clarity server error (HTTP ${status})` };
    }
    return { code: ErrorCode.UNKNOWN, retryable: false, message: `Unexpected HTTP status ${status} from Clarity` };
}

/** Classify an error thrown while calling Clarity (no HTTP response). */
export function classifyThrown(error: unknown): FailureClass {
    if (error instanceof ClarityTimeoutError) {
        return { code: ErrorCode.TIMEOUT, retryable: false, message: error.message };
    }
    if (error instanceof ClarityNetworkError) {
        return { code: ErrorCode.NETWORK_ERROR, retryable: true, message: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { code: ErrorCode.UNKNOWN, retryable: false, message };
}
