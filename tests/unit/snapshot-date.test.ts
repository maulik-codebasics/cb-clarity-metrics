import { describe, expect, it } from 'vitest';
import { budgetDateFor, dataWindowFor, snapshotDateFor } from '@/etl/snapshot-date';

const IST = 'Asia/Kolkata';

describe('snapshotDateFor', () => {
    it('is yesterday (IST) for the 00:30 IST scheduled run', () => {
        // 2026-11-26 00:30 IST = 2026-11-25 19:00 UTC
        expect(snapshotDateFor(new Date('2026-11-25T19:00:00Z'), IST)).toBe('2026-11-25');
    });

    it('changes exactly at IST midnight, not UTC midnight', () => {
        // 23:59:59 IST on the 25th → snapshot 24th
        expect(snapshotDateFor(new Date('2026-11-25T18:29:59Z'), IST)).toBe('2026-11-24');
        // 00:00:00 IST on the 26th → snapshot 25th
        expect(snapshotDateFor(new Date('2026-11-25T18:30:00Z'), IST)).toBe('2026-11-25');
        // UTC midnight is 05:30 IST: no change there
        expect(snapshotDateFor(new Date('2026-11-25T23:59:59Z'), IST)).toBe('2026-11-25');
        expect(snapshotDateFor(new Date('2026-11-26T00:00:00Z'), IST)).toBe('2026-11-25');
    });

    it('handles month and year boundaries', () => {
        expect(snapshotDateFor(new Date('2026-02-28T19:00:00Z'), IST)).toBe('2026-02-28'); // 1 Mar 00:30 IST
        expect(snapshotDateFor(new Date('2026-12-31T19:00:00Z'), IST)).toBe('2026-12-31'); // 1 Jan 00:30 IST
        expect(snapshotDateFor(new Date('2028-02-29T19:00:00Z'), IST)).toBe('2028-02-29'); // leap year
    });

    it('a same-day late run still targets yesterday', () => {
        // 10:15 IST on the 26th
        expect(snapshotDateFor(new Date('2026-11-26T04:45:00Z'), IST)).toBe('2026-11-25');
    });
});

describe('budgetDateFor', () => {
    it('defaults to the IST calendar date', () => {
        expect(budgetDateFor(new Date('2026-11-25T18:29:00Z'), IST, 0)).toBe('2026-11-25');
        expect(budgetDateFor(new Date('2026-11-25T18:31:00Z'), IST, 0)).toBe('2026-11-26');
    });

    it('moves the reset boundary by the offset (330 min = UTC midnight)', () => {
        expect(budgetDateFor(new Date('2026-11-25T23:59:00Z'), IST, 330)).toBe('2026-11-25');
        expect(budgetDateFor(new Date('2026-11-26T00:01:00Z'), IST, 330)).toBe('2026-11-26');
    });
});

describe('dataWindowFor', () => {
    it('counts back 24h per day from the call time', () => {
        const calledAt = new Date('2026-11-25T19:00:00Z');
        expect(dataWindowFor(calledAt, 1)).toEqual({ start: new Date('2026-11-24T19:00:00Z'), end: calledAt });
    });
});
