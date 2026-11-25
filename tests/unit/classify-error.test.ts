import { describe, expect, it } from 'vitest';
import { ClarityNetworkError, ClarityTimeoutError, buildClarityUrl, createHttpClarityClient, fixtureFileFor } from '@/etl/clarity-client';
import { classifyHttpStatus, classifyThrown } from '@/etl/classify-error';

describe('classifyHttpStatus', () => {
    it.each([
        [400, 'BAD_REQUEST', false],
        [401, 'AUTH_ERROR', false],
        [403, 'AUTH_ERROR', false],
        [429, 'RATE_LIMITED', false],
        [500, 'SERVER_ERROR', true],
        [502, 'SERVER_ERROR', true],
        [503, 'SERVER_ERROR', true],
        [404, 'UNKNOWN', false],
    ])('HTTP %i → %s (retryable: %s)', (status, code, retryable) => {
        expect(classifyHttpStatus(status)).toMatchObject({ code, retryable });
    });

    it('returns null for 2xx', () => {
        expect(classifyHttpStatus(200)).toBeNull();
    });
});

describe('classifyThrown', () => {
    it('timeout → TIMEOUT, not retried', () => {
        expect(classifyThrown(new ClarityTimeoutError(60_000))).toMatchObject({ code: 'TIMEOUT', retryable: false });
    });

    it('network failure → NETWORK_ERROR, retried', () => {
        expect(classifyThrown(new ClarityNetworkError('fetch failed'))).toMatchObject({ code: 'NETWORK_ERROR', retryable: true });
    });

    it('anything else → UNKNOWN', () => {
        expect(classifyThrown(new Error('boom'))).toMatchObject({ code: 'UNKNOWN', retryable: false });
    });
});

describe('http client', () => {
    it('builds the documented URL with dimension1..n', () => {
        expect(buildClarityUrl({ numOfDays: 1, dimensions: ['Source', 'Medium'] })).toBe(
            'https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=1&dimension1=Source&dimension2=Medium',
        );
    });

    it('sends the token only in the Authorization header and returns non-2xx without throwing', async () => {
        let seen: RequestInit | undefined;
        const client = createHttpClarityClient({
            token: 'secret-token',
            fetchFn: async (_url, init) => {
                seen = init;
                return new Response('', { status: 429 });
            },
        });
        await expect(client.fetchLiveInsights({ numOfDays: 1, dimensions: [] })).resolves.toEqual({ status: 429, bodyText: '' });
        expect((seen?.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
    });

    it('maps an aborted request to ClarityTimeoutError', async () => {
        const client = createHttpClarityClient({
            token: 't',
            timeoutMs: 10,
            fetchFn: async () => {
                throw new DOMException('The operation timed out', 'TimeoutError');
            },
        });
        await expect(client.fetchLiveInsights({ numOfDays: 1, dimensions: [] })).rejects.toBeInstanceOf(ClarityTimeoutError);
    });

    it('maps a connection failure to ClarityNetworkError', async () => {
        const client = createHttpClarityClient({
            token: 't',
            fetchFn: async () => {
                throw new TypeError('fetch failed');
            },
        });
        await expect(client.fetchLiveInsights({ numOfDays: 1, dimensions: [] })).rejects.toBeInstanceOf(ClarityNetworkError);
    });
});

describe('fixtureFileFor', () => {
    it('maps dimensions to fixture files', () => {
        expect(fixtureFileFor([])).toBe('overall.json');
        expect(fixtureFileFor(['Device'])).toBe('device.json');
        expect(fixtureFileFor(['Source', 'Medium'])).toBe('source_medium.json');
        expect(fixtureFileFor(['URL'])).toBe('url.json');
    });
});
