import 'dotenv/config';

/** Separate database for integration tests; every table is truncated between tests. */
export const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST ?? 'postgresql://clarity:clarity@localhost:5432/clarity_test';

if (TEST_DATABASE_URL === process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL_TEST must not point at the main DATABASE_URL (tests wipe it)');
}
