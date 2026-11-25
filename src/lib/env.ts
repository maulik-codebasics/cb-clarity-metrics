import { z } from 'zod';

const optionalString = z
    .string()
    .trim()
    .transform((value) => (value === '' ? undefined : value))
    .optional();

/**
 * Settings the ETL and CLI scripts need. The web app's auth settings are
 * validated separately so cron scripts don't need Entra credentials.
 */
const etlEnvSchema = z
    .object({
        DATABASE_URL: z.string({ error: 'is required' }).min(1, 'is required'),
        CLARITY_API_TOKEN: optionalString,
        CLARITY_MOCK: z.stringbool().default(false),
        CLARITY_DAILY_CALL_BUDGET: z.coerce.number().int().min(1).max(10).default(10),
        CLARITY_RESERVED_CALLS: z.coerce.number().int().min(0).default(2),
        CLARITY_BUDGET_RESET_OFFSET_MINUTES: z.coerce.number().int().min(-1440).max(1440).default(0),
        CRON_SCHEDULE: z.string().default('30 0 * * *'),
        APP_TIMEZONE: z.string().default('Asia/Kolkata'),
        APP_BASE_URL: optionalString,
        STRIP_URL_QUERY: z.stringbool().default(true),
        RAW_RETENTION_DAYS: z.coerce.number().int().min(1).default(180),
        TEAMS_WEBHOOK_URL: optionalString,
        SMTP_HOST: optionalString,
        SMTP_PORT: z.coerce.number().int().optional(),
        SMTP_USER: optionalString,
        SMTP_PASS: optionalString,
        ALERT_EMAIL_TO: optionalString,
        LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    })
    .superRefine((env, ctx) => {
        if (!env.CLARITY_MOCK && !env.CLARITY_API_TOKEN) {
            ctx.addIssue({
                code: 'custom',
                path: ['CLARITY_API_TOKEN'],
                message: 'is required unless CLARITY_MOCK=true',
            });
        }
        if (env.CLARITY_RESERVED_CALLS >= env.CLARITY_DAILY_CALL_BUDGET) {
            ctx.addIssue({
                code: 'custom',
                path: ['CLARITY_RESERVED_CALLS'],
                message: 'must be lower than CLARITY_DAILY_CALL_BUDGET',
            });
        }
    });

export type EtlEnv = z.infer<typeof etlEnvSchema>;

let cached: EtlEnv | undefined;

/**
 * Parse and cache the ETL environment. Throws one error listing every invalid variable.
 */
export function getEtlEnv(source: Record<string, string | undefined> = process.env): EtlEnv {
    if (cached && source === process.env) {
        return cached;
    }
    const result = etlEnvSchema.safeParse(source);
    if (!result.success) {
        const lines = result.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
        throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
    }
    if (source === process.env) {
        cached = result.data;
    }
    return result.data;
}
