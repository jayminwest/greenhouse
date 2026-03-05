import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { budgetExhausted, computeBudget, getDailyBudget } from "./budget.ts";
import { appendRun } from "./state.ts";
import type { RunState } from "./types.ts";

const TMP = join(import.meta.dir, ".test-budget-tmp");

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

function makeRun(overrides: Partial<RunState> = {}): RunState {
	return {
		ghIssueId: 1,
		ghRepo: "jayminwest/overstory",
		ghTitle: "Test issue",
		ghLabels: ["agent-ready"],
		seedsId: "overstory-a1b2",
		status: "running",
		discoveredAt: `${TODAY}T10:00:00Z`,
		dispatchedAt: `${TODAY}T10:05:00Z`,
		updatedAt: `${TODAY}T10:05:00Z`,
		...overrides,
	};
}

beforeEach(() => {
	mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
});

describe("getDailyBudget", () => {
	test("returns zero dispatched for empty state", async () => {
		const budget = await getDailyBudget(5, TMP);
		expect(budget.date).toBe(TODAY);
		expect(budget.dispatched).toBe(0);
		expect(budget.cap).toBe(5);
		expect(budget.remaining).toBe(5);
	});

	test("counts dispatched runs for today", async () => {
		await appendRun(makeRun({ ghIssueId: 1 }), TMP);
		await appendRun(makeRun({ ghIssueId: 2 }), TMP);
		const budget = await getDailyBudget(5, TMP);
		expect(budget.dispatched).toBe(2);
		expect(budget.remaining).toBe(3);
	});

	test("ignores runs dispatched yesterday", async () => {
		await appendRun(makeRun({ ghIssueId: 1, dispatchedAt: `${YESTERDAY}T10:05:00Z` }), TMP);
		const budget = await getDailyBudget(5, TMP);
		expect(budget.dispatched).toBe(0);
		expect(budget.remaining).toBe(5);
	});

	test("ignores pending runs (no dispatchedAt)", async () => {
		await appendRun(makeRun({ ghIssueId: 1, status: "pending", dispatchedAt: undefined }), TMP);
		const budget = await getDailyBudget(5, TMP);
		expect(budget.dispatched).toBe(0);
	});

	test("remaining is zero when cap exhausted, not negative", async () => {
		await appendRun(makeRun({ ghIssueId: 1 }), TMP);
		await appendRun(makeRun({ ghIssueId: 2 }), TMP);
		await appendRun(makeRun({ ghIssueId: 3 }), TMP);
		const budget = await getDailyBudget(2, TMP); // cap of 2, but 3 dispatched
		expect(budget.remaining).toBe(0);
		expect(budget.dispatched).toBe(3);
	});
});

describe("budgetExhausted", () => {
	test("returns true when remaining is 0", () => {
		expect(budgetExhausted({ date: TODAY, dispatched: 5, cap: 5, remaining: 0 })).toBe(true);
	});

	test("returns false when remaining > 0", () => {
		expect(budgetExhausted({ date: TODAY, dispatched: 3, cap: 5, remaining: 2 })).toBe(false);
	});
});

describe("computeBudget", () => {
	test("computes budget from run list inline", () => {
		const runs: RunState[] = [makeRun({ ghIssueId: 1 }), makeRun({ ghIssueId: 2 })];
		const budget = computeBudget(runs, 5);
		expect(budget.dispatched).toBe(2);
		expect(budget.remaining).toBe(3);
	});

	test("ignores runs without dispatchedAt", () => {
		const runs: RunState[] = [
			makeRun({ ghIssueId: 1, status: "pending", dispatchedAt: undefined }),
		];
		const budget = computeBudget(runs, 5);
		expect(budget.dispatched).toBe(0);
	});
});
