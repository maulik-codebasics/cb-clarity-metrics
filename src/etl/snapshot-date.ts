import { addDaysToIsoDate, dateInZone, type IsoDate } from '@/lib/time';

const HOUR_MS = 60 * 60 * 1000;

/**
 * The business date a run's data belongs to: the run's calendar date in the
 * app timezone, minus one day. A call at 00:30 IST covers (roughly) yesterday.
 */
export function snapshotDateFor(now: Date, timeZone: string): IsoDate {
    return addDaysToIsoDate(dateInZone(now, timeZone), -1);
}

/**
 * The day an API call counts against for the daily budget. Clarity doesn't
 * document when its limit resets, so the boundary is IST midnight shifted by
 * `resetOffsetMinutes` (e.g. 330 = 05:30 IST = UTC midnight).
 */
export function budgetDateFor(now: Date, timeZone: string, resetOffsetMinutes: number): IsoDate {
    return dateInZone(new Date(now.getTime() - resetOffsetMinutes * 60 * 1000), timeZone);
}

/** The period a `numOfDays` call covers: counted back from the moment of the call. */
export function dataWindowFor(calledAt: Date, numOfDays: number): { start: Date; end: Date } {
    return { start: new Date(calledAt.getTime() - numOfDays * 24 * HOUR_MS), end: calledAt };
}
