import { describe, expect, it } from 'vitest';
import { getEtlEnv } from '@/lib/env';
import { redactText, redactValue } from '@/lib/redact';

describe('redaction', () => {
    it('removes the token and bearer headers from text', () => {
        const text = 'failed with Authorization: Bearer abc.def-123 and token my-secret-token in body';
        const result = redactText(text, ['my-secret-token']);
        expect(result).not.toContain('abc.def-123');
        expect(result).not.toContain('my-secret-token');
    });

    it('redacts secret-named keys and secret values deep in objects', () => {
        const result = redactValue({ headers: { authorization: 'x' }, nested: [{ msg: 'got my-secret-token' }] }, ['my-secret-token']);
        expect(JSON.stringify(result)).not.toContain('my-secret-token');
        expect(result.headers.authorization).toBe('[REDACTED]');
    });
});

describe('env validation', () => {
    it('fails fast with a clear message', () => {
        expect(() => getEtlEnv({})).toThrow('DATABASE_URL: is required');
        expect(() => getEtlEnv({ DATABASE_URL: 'postgresql://x', CLARITY_RESERVED_CALLS: '12' })).toThrow(
            /CLARITY_API_TOKEN: .*unless CLARITY_MOCK=true[\s\S]*CLARITY_RESERVED_CALLS: must be lower/,
        );
    });

    it('applies defaults', () => {
        const env = getEtlEnv({ DATABASE_URL: 'postgresql://x', CLARITY_MOCK: 'true' });
        expect(env).toMatchObject({
            CLARITY_DAILY_CALL_BUDGET: 10,
            CLARITY_RESERVED_CALLS: 2,
            APP_TIMEZONE: 'Asia/Kolkata',
            STRIP_URL_QUERY: true,
            RAW_RETENTION_DAYS: 180,
        });
    });
});
