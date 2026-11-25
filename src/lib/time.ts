import { formatInTimeZone } from 'date-fns-tz';

/** A calendar date as `YYYY-MM-DD`. */
export type IsoDate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar date of `instant` in `timeZone`. */
export function dateInZone(instant: Date, timeZone: string): IsoDate {
    return formatInTimeZone(instant, timeZone, 'yyyy-MM-dd');
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Add whole days to a calendar date. Works in UTC, so the server's own timezone never matters. */
export function addDaysToIsoDate(date: IsoDate, days: number): IsoDate {
    return utcToIsoDate(new Date(isoDateToUtc(date).getTime() + days * DAY_MS));
}

/** `YYYY-MM-DD` → Date at UTC midnight, the form Prisma expects for `@db.Date` columns. */
export function isoDateToUtc(date: IsoDate): Date {
    if (!ISO_DATE.test(date)) {
        throw new Error(`Invalid ISO date: ${date}`);
    }
    return new Date(`${date}T00:00:00.000Z`);
}

/** Date from a `@db.Date` column (UTC midnight) → `YYYY-MM-DD`. */
export function utcToIsoDate(value: Date): IsoDate {
    return value.toISOString().slice(0, 10);
}
