import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ClarityDimension } from './types';

export const CLARITY_ENDPOINT = 'https://www.clarity.ms/export-data/api/v1/project-live-insights';
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface ClarityRequest {
    numOfDays: 1 | 2 | 3;
    dimensions: readonly ClarityDimension[];
}

/** Raw HTTP result. Non-2xx statuses are returned, not thrown; the caller classifies them. */
export interface ClarityResponse {
    status: number;
    bodyText: string;
}

/** Thrown when the request didn't complete within the timeout. */
export class ClarityTimeoutError extends Error {
    constructor(timeoutMs: number) {
        super(`Clarity request timed out after ${timeoutMs / 1000}s`);
        this.name = 'ClarityTimeoutError';
    }
}

/** Thrown when no HTTP response was received (DNS, connection reset, TLS...). */
export class ClarityNetworkError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'ClarityNetworkError';
    }
}

export interface ClarityClient {
    fetchLiveInsights(request: ClarityRequest): Promise<ClarityResponse>;
}

export function buildClarityUrl(request: ClarityRequest): string {
    const url = new URL(CLARITY_ENDPOINT);
    url.searchParams.set('numOfDays', String(request.numOfDays));
    request.dimensions.forEach((dimension, index) => {
        url.searchParams.set(`dimension${index + 1}`, dimension);
    });
    return url.toString();
}

/** Real client. The token is only ever placed in the Authorization header. */
export function createHttpClarityClient(options: { token: string; timeoutMs?: number; fetchFn?: typeof fetch }): ClarityClient {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetchFn = options.fetchFn ?? fetch;
    return {
        async fetchLiveInsights(request) {
            let response: Response;
            try {
                response = await fetchFn(buildClarityUrl(request), {
                    method: 'GET',
                    headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/json' },
                    signal: AbortSignal.timeout(timeoutMs),
                });
                return { status: response.status, bodyText: await response.text() };
            } catch (error) {
                if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
                    throw new ClarityTimeoutError(timeoutMs);
                }
                const message = error instanceof Error ? error.message : String(error);
                throw new ClarityNetworkError(`Network error calling Clarity: ${message}`, { cause: error });
            }
        },
    };
}

/** Fixture file for a set of dimensions: [] → overall.json, [Source, Medium] → source_medium.json. */
export function fixtureFileFor(dimensions: readonly ClarityDimension[]): string {
    if (dimensions.length === 0) {
        return 'overall.json';
    }
    return `${dimensions.map((d) => d.toLowerCase().replace(/[^a-z0-9]+/g, '_')).join('_')}.json`;
}

/** Dry-run client for CLARITY_MOCK=true: serves fixture JSON and never calls Clarity. */
export function createFixtureClarityClient(fixturesDir: string): ClarityClient {
    return {
        async fetchLiveInsights(request) {
            const file = path.join(fixturesDir, fixtureFileFor(request.dimensions));
            try {
                return { status: 200, bodyText: await readFile(file, 'utf8') };
            } catch {
                return { status: 200, bodyText: await readFile(path.join(fixturesDir, 'overall.json'), 'utf8') };
            }
        },
    };
}
