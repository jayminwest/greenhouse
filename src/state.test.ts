import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	appendRun,
	getFailedRetryableRuns,
	isIngested,
	readState,
	updateRun,
	writeAllRuns,
} from "./state.ts";
import type { RunState } from "./types.ts";

const TMP = join(import.meta.dir, ".test-state-tmp");

function makeRun(overrides: Partial<RunState> = {}): RunState {
	return {
		ghIssueId: 42,
		ghRepo: "jayminwest/overstory",
		ghTitle: "Fix retry logic",
		ghLabels: ["agent-ready"],
		seedsId: "overstory-a1b2",
		status: "pending",
		discoveredAt: "2026-03-05T10:00:00Z",
		updatedAt: "2026-03-05T10:00:00Z",
		...overrides,
	};
}

beforeEach(() => {
	mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
});

describe("readState", () => {
	test("returns empty array for non-existent file", async () => {
		const runs = await readState(TMP);
		expect(runs).toEqual([]);
	});

	test("reads and parses JSONL entries", async () => {
		const run = makeRun();
		await appendRun(run, TMP);
		const runs = await readState(TMP);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.ghIssueId).toBe(42);
	});

	test("deduplicates by (ghRepo, ghIssueId) — last wins", async () => {
		const run1 = makeRun({ status: "pending" });
		const run2 = makeRun({ status: "running" });
		await appendRun(run1, TMP);
		await appendRun(run2, TMP);
		const runs = await readState(TMP);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.status).toBe("running");
	});

	test("keeps distinct (ghRepo, ghIssueId) pairs", async () => {
		const run1 = makeRun({ ghIssueId: 1, seedsId: "a" });
		const run2 = makeRun({ ghIssueId: 2, seedsId: "b" });
		await appendRun(run1, TMP);
		await appendRun(run2, TMP);
		const runs = await readState(TMP);
		expect(runs).toHaveLength(2);
	});
});

describe("appendRun", () => {
	test("appends to non-existent file", async () => {
		const run = makeRun();
		await appendRun(run, TMP);
		const runs = await readState(TMP);
		expect(runs).toHaveLength(1);
	});

	test("appends multiple entries", async () => {
		await appendRun(makeRun({ ghIssueId: 1, seedsId: "a" }), TMP);
		await appendRun(makeRun({ ghIssueId: 2, seedsId: "b" }), TMP);
		await appendRun(makeRun({ ghIssueId: 3, seedsId: "c" }), TMP);
		const runs = await readState(TMP);
		expect(runs).toHaveLength(3);
	});
});

describe("updateRun", () => {
	test("updates a run by (ghIssueId, ghRepo)", async () => {
		await appendRun(makeRun(), TMP);
		const updated = await updateRun(42, "jayminwest/overstory", { status: "running" }, TMP);
		expect(updated.status).toBe("running");
		const runs = await readState(TMP);
		expect(runs[0]?.status).toBe("running");
	});

	test("sets updatedAt automatically", async () => {
		await appendRun(makeRun(), TMP);
		const before = Date.now();
		const updated = await updateRun(42, "jayminwest/overstory", { status: "shipped" }, TMP);
		expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(before);
	});

	test("throws if run not found", async () => {
		await expect(
			updateRun(999, "jayminwest/overstory", { status: "shipped" }, TMP),
		).rejects.toThrow("No run found");
	});

	test("preserves other fields", async () => {
		const run = makeRun({ agentName: "lead-a1b2" });
		await appendRun(run, TMP);
		const updated = await updateRun(42, "jayminwest/overstory", { status: "shipped" }, TMP);
		expect(updated.agentName).toBe("lead-a1b2");
		expect(updated.ghTitle).toBe("Fix retry logic");
	});
});

describe("isIngested", () => {
	test("returns false for unknown issue", async () => {
		expect(await isIngested(TMP, "owner/repo", 999)).toBe(false);
	});

	test("returns true for pending run", async () => {
		await appendRun(makeRun({ ghRepo: "owner/repo", ghIssueId: 1, status: "pending" }), TMP);
		expect(await isIngested(TMP, "owner/repo", 1)).toBe(true);
	});

	test("returns true for failed run", async () => {
		await appendRun(makeRun({ ghRepo: "owner/repo", ghIssueId: 2, status: "failed" }), TMP);
		expect(await isIngested(TMP, "owner/repo", 2)).toBe(true);
	});

	test("returns true for shipped run", async () => {
		await appendRun(makeRun({ ghRepo: "owner/repo", ghIssueId: 3, status: "shipped" }), TMP);
		expect(await isIngested(TMP, "owner/repo", 3)).toBe(true);
	});
});

describe("getFailedRetryableRuns", () => {
	test("returns empty array when no failed runs", async () => {
		await appendRun(makeRun({ status: "running" }), TMP);
		const failed = await getFailedRetryableRuns(TMP);
		expect(failed).toEqual([]);
	});

	test("returns only failed retryable runs", async () => {
		await appendRun(
			makeRun({ ghIssueId: 1, seedsId: "a", status: "failed", retryable: true }),
			TMP,
		);
		await appendRun(
			makeRun({ ghIssueId: 2, seedsId: "b", status: "failed", retryable: false }),
			TMP,
		);
		await appendRun(makeRun({ ghIssueId: 3, seedsId: "c", status: "running" }), TMP);
		const failed = await getFailedRetryableRuns(TMP);
		expect(failed).toHaveLength(1);
		expect(failed[0]?.ghIssueId).toBe(1);
	});
});

describe("writeAllRuns", () => {
	test("overwrites state with new run list", async () => {
		await appendRun(makeRun({ ghIssueId: 1, seedsId: "a" }), TMP);
		await appendRun(makeRun({ ghIssueId: 2, seedsId: "b" }), TMP);
		const single = makeRun({ ghIssueId: 99, seedsId: "z" });
		await writeAllRuns([single], TMP);
		const runs = await readState(TMP);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.ghIssueId).toBe(99);
	});
});
