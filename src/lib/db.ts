import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';

/** Create a Prisma client over the node-postgres driver adapter. */
export function createPrismaClient(connectionString: string): PrismaClient {
    return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** Shared client for the web app (survives Next.js hot reloads in dev). */
export function getPrisma(): PrismaClient {
    if (!globalForPrisma.prisma) {
        const url = process.env.DATABASE_URL;
        if (!url) {
            throw new Error('DATABASE_URL is required');
        }
        globalForPrisma.prisma = createPrismaClient(url);
    }
    return globalForPrisma.prisma;
}

export type { PrismaClient };
