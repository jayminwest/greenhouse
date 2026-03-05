import type { DailyBudget } from "./types.ts";

function todayStr(): string {
	return new Date().toISOString().slice(0, 10);
}

/** In-memory daily budget tracker. Resets at midnight (when date changes). */
export class BudgetTracker {
	private date: string;
	private dispatched: number;
	private cap: number;

	constructor(cap: number) {
		this.cap = cap;
		this.date = todayStr();
		this.dispatched = 0;
	}

	/** Check if we have budget remaining for today. */
	hasCapacity(): boolean {
		this.maybeReset();
		return this.dispatched < this.cap;
	}

	/** Record a dispatched issue. */
	consume(): void {
		this.maybeReset();
		this.dispatched++;
	}

	/** Get current budget status. */
	status(): DailyBudget {
		this.maybeReset();
		return {
			date: this.date,
			dispatched: this.dispatched,
			cap: this.cap,
			remaining: Math.max(0, this.cap - this.dispatched),
		};
	}

	private maybeReset(): void {
		const today = todayStr();
		if (today !== this.date) {
			this.date = today;
			this.dispatched = 0;
		}
	}
}
