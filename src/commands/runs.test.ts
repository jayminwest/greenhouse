/**
 * Tests for grhs runs clean subcommand
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendRun } from "../state.ts";
import type { RunState } from "../types.ts";
import { cleanRuns } from "./runs.ts";

const TEST_DIR = join(import.meta.dir, "__test_runs__");

function makeRun(overrides: Partial<RunState> & { ghIssueId: number }): RunState {
	const { ghIssueId } = overrides;
	return {
		ghRepo: "testorg/testrepo",
		ghTitle: `Issue #${ghIssueId}`,
		ghLabels: [],
		seedsId: `greenhouse-${ghIssueId}`,
		status: "pending",
		discoveredAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

describe("cleanRuns", () => {
	beforeEach(() => {
		mkdirSync(join(TEST_DIR, ".greenhouse"), { recursive: true });
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("removes shipped and non-retryable failed runs by default", async () => {
		await appendRun(makeRun({ ghIssueId: 1, status: "pending" }), TEST_DIR);
		await appendRun(makeRun({ ghIssueId: 2, status: "running" }), TEST_DIR);
		await appendRun(makeRun({ ghIssueId: 3, status: "shipped" }), TEST_DIR);
		await appendRun(makeRun({ ghIssueId: 4, status: "failed" }), TEST_DIR);
		await appendRun(makeRun({ ghIssueId: 5, status: "failed", retryable: true }), TEST_DIR);

		const result = await cleanRuns(TEST_DIR);

		expect(result.removed).toBe(2); // shipped + non-retryable failed
		expect(result.remaining).toBe(3); // pending + running + retryable failed
	});

	it("--keep-shipped only removes non-retryable failed runs", async () => {
		await appendRun(makeRun({ ghIssueId: 1, status: "pending" }), TEST_DIR);
		await appendRun(makeRun({ ghIssueId: 2, status: "shipped" }), TEST_DIR);
		await appendRun(makeRun({ ghIssueId: 3, status: "failed" }), TEST_DIR);
		await appendRun(makeRun({ ghIssueId: 4, status: "failed", retryable: true }), TEST_DIR);

		const result = await cleanRuns(TEST_DIR, { keepShipped: true });

		expect(result.removed).toBe(1); // only non-retryable failed
		expect(result.remaining).toBe(3); // pending + shipped + retryable failed
	});

	it("returns zero removed for empty state", async () => {
		const result = await cleanRuns(TEST_DIR);
		expect(result.removed).toBe(0);
		expect(result.remaining).toBe(0);
	});

	it("returns zero removed when all runs are active", async () => {
		await appendRun(makeRun({ ghIssueId: 1, status: "pending" }), TEST_DIR);
		await appendRun(makeRun({ ghIssueId: 2, status: "running" }), TEST_DIR);
		await appendRun(makeRun({ ghIssueId: 3, status: "ingested" }), TEST_DIR);

		const result = await cleanRuns(TEST_DIR);
		expect(result.removed).toBe(0);
		expect(result.remaining).toBe(3);
	});

	it("removes all runs when all are shipped", async () => {
		await appendRun(makeRun({ ghIssueId: 1, status: "shipped" }), TEST_DIR);
		await appendRun(makeRun({ ghIssueId: 2, status: "shipped" }), TEST_DIR);

		const result = await cleanRuns(TEST_DIR);
		expect(result.removed).toBe(2);
		expect(result.remaining).toBe(0);
	});

	it("preserves retryable failed runs", async () => {
		await appendRun(makeRun({ ghIssueId: 1, status: "failed", retryable: true }), TEST_DIR);
		await appendRun(makeRun({ ghIssueId: 2, status: "failed" }), TEST_DIR);

		const result = await cleanRuns(TEST_DIR);
		expect(result.removed).toBe(1);
		expect(result.remaining).toBe(1);
	});
});
