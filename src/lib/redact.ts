const REDACTED = '[REDACTED]';
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;

/**
 * Remove secrets from a string: every occurrence of the given secret values,
 * plus anything that looks like a bearer token.
 */
export function redactText(text: string, secrets: ReadonlyArray<string | undefined> = []): string {
    let result = text.replace(BEARER, `Bearer ${REDACTED}`);
    for (const secret of secrets) {
        if (secret && secret.length >= 4) {
            result = result.split(secret).join(REDACTED);
        }
    }
    return result;
}

/** Deep-copy a JSON-like value with every string passed through `redactText`. */
export function redactValue<T>(value: T, secrets: ReadonlyArray<string | undefined> = []): T {
    if (typeof value === 'string') {
        return redactText(value, secrets) as T;
    }
    if (Array.isArray(value)) {
        return value.map((item: unknown) => redactValue(item, secrets)) as T;
    }
    if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = /authorization|token|secret|password/i.test(key) ? REDACTED : redactValue(item, secrets);
        }
        return out as T;
    }
    return value;
}
