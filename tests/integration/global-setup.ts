import 'dotenv/config';
import { execSync } from 'node:child_process';
import { TEST_DATABASE_URL } from './test-db-url';

/** Apply migrations to the test database once per test run. */
export default function setup(): void {
    execSync('npx prisma migrate deploy', {
        env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
        stdio: 'pipe',
    });
}
