import { readState } from "./state.ts";
import type { DailyBudget, RunState } from "./types.ts";

function todayDate(): string {
	return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function countDispatchedToday(runs: RunState[], date: string): number {
	return runs.filter((r) => {
		if (!r.dispatchedAt) return false;
		return r.dispatchedAt.slice(0, 10) === date;
	}).length;
}

export async function getDailyBudget(cap: number, greeniouseDir?: string): Promise<DailyBudget> {
	const runs = await readState(greeniouseDir);
	const date = todayDate();
	const dispatched = countDispatchedToday(runs, date);
	return {
		date,
		dispatched,
		cap,
		remaining: Math.max(0, cap - dispatched),
	};
}

export function budgetExhausted(budget: DailyBudget): boolean {
	return budget.remaining <= 0;
}

/** Compute budget from an already-loaded run list (no I/O). */
export function computeBudget(runs: RunState[], cap: number): DailyBudget {
	const date = todayDate();
	const dispatched = countDispatchedToday(runs, date);
	return {
		date,
		dispatched,
		cap,
		remaining: Math.max(0, cap - dispatched),
	};
}
