import pino, { type Logger } from 'pino';

/**
 * Structured JSON logger. Secret-bearing keys are redacted wherever they appear
 * one or two levels deep; error messages are scrubbed separately via redactText().
 */
export function createLogger(level: string = process.env.LOG_LEVEL ?? 'info'): Logger {
    return pino({
        level,
        base: { app: 'clarity-insights' },
        timestamp: pino.stdTimeFunctions.isoTime,
        redact: {
            paths: [
                'token',
                'authorization',
                'headers.authorization',
                '*.token',
                '*.authorization',
                '*.headers.authorization',
                'CLARITY_API_TOKEN',
                '*.CLARITY_API_TOKEN',
            ],
            censor: '[REDACTED]',
        },
    });
}

export type { Logger };
