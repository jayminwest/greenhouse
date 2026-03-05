import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
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

/**
 * Append a run state entry to state.jsonl (append-only log).
 */
export async function appendRun(projectRoot: string, run: RunState): Promise<void> {
	const statePath = join(projectRoot, STATE_FILE);
	await appendFile(statePath, `${JSON.stringify(run)}\n`);
}

/**
 * Check if a GitHub issue has already been ingested.
 */
export async function isIngested(
	projectRoot: string,
	ghRepo: string,
	ghIssueId: number,
): Promise<boolean> {
	const runs = await readAllRuns(projectRoot);
	return runs.some(
		(r) => r.ghRepo === ghRepo && r.ghIssueId === ghIssueId && r.status !== "failed",
	);
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
 * Update the status of a run (appends new entry; dedup on read).
 */
export async function updateRun(
	projectRoot: string,
	run: RunState,
	updates: Partial<RunState> & { status: RunStatus },
): Promise<RunState> {
	const updated: RunState = {
		...run,
		...updates,
		updatedAt: new Date().toISOString(),
	};
	await appendRun(projectRoot, updated);
	return updated;
}

/**
 * Get all active runs (running or shipping) across all repos.
 */
export async function getActiveRuns(projectRoot: string): Promise<RunState[]> {
	const runs = await readAllRuns(projectRoot);
	return runs.filter((r) => r.status === "running" || r.status === "shipping");
}
