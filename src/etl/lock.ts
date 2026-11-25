import { Client } from 'pg';

/** Arbitrary constant identifying the ETL lock in pg_locks. */
export const ETL_LOCK_KEY = 727_274_001;

export interface RunLock {
    release(): Promise<void>;
}

export interface LockProvider {
    /** Returns a held lock, or null if another run holds it. Never waits. */
    tryAcquire(): Promise<RunLock | null>;
}

/**
 * Session-level Postgres advisory lock on its own connection, held for the whole
 * run. If the process dies the connection closes and Postgres frees the lock.
 */
export function createPgAdvisoryLock(connectionString: string, key: number = ETL_LOCK_KEY): LockProvider {
    return {
        async tryAcquire() {
            const client = new Client({ connectionString });
            await client.connect();
            try {
                const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [key]);
                if (!result.rows[0]?.locked) {
                    await client.end();
                    return null;
                }
            } catch (error) {
                await client.end().catch(() => undefined);
                throw error;
            }
            return {
                async release() {
                    try {
                        await client.query('SELECT pg_advisory_unlock($1)', [key]);
                    } finally {
                        await client.end().catch(() => undefined);
                    }
                },
            };
        },
    };
}
