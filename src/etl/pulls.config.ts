import type { PullDefinition } from './types';

/**
 * Default pulls, seeded into the `pull_configs` table by `npm run db:seed`.
 * At run time the ETL reads the table (editable in Settings), not this file.
 * Each enabled pull costs one Clarity API call per run (more if retried).
 */
export const DEFAULT_PULLS: readonly PullDefinition[] = [
    { key: 'overall', dimensions: [], enabled: true, displayOrder: 1 },
    { key: 'device', dimensions: ['Device'], enabled: true, displayOrder: 2 },
    { key: 'source_medium', dimensions: ['Source', 'Medium'], enabled: true, displayOrder: 3 },
    { key: 'url', dimensions: ['URL'], enabled: true, displayOrder: 4 },
];

/** Every scheduled run asks for the last 24 hours. See PRD §4.2 (no backfill). */
export const NUM_OF_DAYS = 1 as const;
