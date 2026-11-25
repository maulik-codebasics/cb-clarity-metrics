import { describe, expect, it } from 'vitest';
import { callLimit, canMakeCall, remainingCalls } from '@/etl/budget';

const policy = { dailyBudget: 10, reserved: 2 };

describe('budget guard', () => {
    it('scheduled runs stop at budget - reserved', () => {
        expect(callLimit(policy, false)).toBe(8);
        expect(canMakeCall(7, policy, false)).toBe(true);
        expect(canMakeCall(8, policy, false)).toBe(false);
    });

    it('confirmed manual runs may use the reserved calls, never more than the budget', () => {
        expect(canMakeCall(8, policy, true)).toBe(true);
        expect(canMakeCall(9, policy, true)).toBe(true);
        expect(canMakeCall(10, policy, true)).toBe(false);
    });

    it('reports remaining calls without going negative', () => {
        expect(remainingCalls(3, policy, false)).toBe(5);
        expect(remainingCalls(9, policy, false)).toBe(0);
        expect(remainingCalls(9, policy, true)).toBe(1);
    });
});
