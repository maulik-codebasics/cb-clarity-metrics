export interface BudgetPolicy {
    /** Clarity's hard limit per project per day (10). */
    dailyBudget: number;
    /** Calls scheduled runs leave free for retries, manual late runs and other tools. */
    reserved: number;
}

/** Most calls a run may have used today, including the one it's about to make. */
export function callLimit(policy: BudgetPolicy, useReservedCalls: boolean): number {
    return useReservedCalls ? policy.dailyBudget : policy.dailyBudget - policy.reserved;
}

/** Whether one more call is allowed, given calls already logged for the budget day. */
export function canMakeCall(usedToday: number, policy: BudgetPolicy, useReservedCalls: boolean): boolean {
    return usedToday + 1 <= callLimit(policy, useReservedCalls);
}

/** Calls still available today (never negative). */
export function remainingCalls(usedToday: number, policy: BudgetPolicy, useReservedCalls: boolean): number {
    return Math.max(0, callLimit(policy, useReservedCalls) - usedToday);
}
