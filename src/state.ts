import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunState, RunStatus } from "./types.ts";

const STATE_FILE = ".greenhouse/state.jsonl";

/**
 * Read all run states from state.jsonl.
 * Deduplicates by (ghIssueId, ghRepo) — last entry wins.
 */
export async function readAllRuns(projectRoot: string): Promise<RunState[]> {
	const statePath = join(projectRoot, STATE_FILE);
	let raw: string;
	try {
		raw = await readFile(statePath, "utf8");
	} catch {
		return [];
	}

	const map = new Map<string, RunState>();
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const entry = JSON.parse(trimmed) as RunState;
			const key = `${entry.ghRepo}#${entry.ghIssueId}`;
			map.set(key, entry);
		} catch {
			// skip malformed lines
		}
	}

	return Array.from(map.values());
}

/** Alias for readAllRuns (foundation API). */
export const readState = readAllRuns;

/**
 * Append a run state entry to state.jsonl (append-only log).
 * Args: (run, projectRoot) — run first, projectRoot second.
 */
export async function appendRun(run: RunState, projectRoot: string): Promise<void> {
	const statePath = join(projectRoot, STATE_FILE);
	await mkdir(dirname(statePath), { recursive: true });
	await appendFile(statePath, `${JSON.stringify(run)}\n`);
}

/**
 * Overwrite state.jsonl entirely with the given run list.
 */
export async function writeAllRuns(runs: RunState[], projectRoot: string): Promise<void> {
	const statePath = join(projectRoot, STATE_FILE);
	await mkdir(dirname(statePath), { recursive: true });
	const content = runs.map((r) => JSON.stringify(r)).join("\n") + (runs.length > 0 ? "\n" : "");
	await writeFile(statePath, content);
}

/**
 * Check if a GitHub issue has already been ingested.
 * Returns true for ANY existing run for that (ghRepo, ghIssueId) pair,
 * including failed runs. Use getFailedRetryableRuns() to find runs that
 * should be retried.
 */
export async function isIngested(
	projectRoot: string,
	ghRepo: string,
	ghIssueId: number,
): Promise<boolean> {
	const runs = await readAllRuns(projectRoot);
	return runs.some((r) => r.ghRepo === ghRepo && r.ghIssueId === ghIssueId);
}

/**
 * Get all failed runs that are eligible for retry (retryable: true).
 */
export async function getFailedRetryableRuns(projectRoot: string): Promise<RunState[]> {
	const runs = await readAllRuns(projectRoot);
	return runs.filter((r) => r.status === "failed" && r.retryable === true);
}

/**
 * Get the current status of a tracked issue.
 */
export async function getRunByIssue(
	projectRoot: string,
	ghRepo: string,
	ghIssueId: number,
): Promise<RunState | undefined> {
	const runs = await readAllRuns(projectRoot);
	return runs.find((r) => r.ghRepo === ghRepo && r.ghIssueId === ghIssueId);
}

/**
 * Update the status of a run by (ghIssueId, ghRepo). Throws if not found.
 * Args: (ghIssueId, ghRepo, updates, projectRoot)
 */
export async function updateRun(
	ghIssueId: number,
	ghRepo: string,
	updates: Partial<RunState> & { status: RunStatus },
	projectRoot: string,
): Promise<RunState> {
	const runs = await readAllRuns(projectRoot);
	const run = runs.find((r) => r.ghRepo === ghRepo && r.ghIssueId === ghIssueId);
	if (!run) {
		throw new Error(`No run found for ${ghRepo}#${ghIssueId}`);
	}
	const updated: RunState = {
		...run,
		...updates,
		updatedAt: new Date().toISOString(),
	};
	await appendRun(updated, projectRoot);
	return updated;
}

/**
 * Get all active runs (running or shipping) across all repos.
 */
export async function getActiveRuns(projectRoot: string): Promise<RunState[]> {
	const runs = await readAllRuns(projectRoot);
	return runs.filter((r) => r.status === "running" || r.status === "shipping");
}
