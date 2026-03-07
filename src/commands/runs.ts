/**
 * grhs runs — List and manage tracked runs
 * grhs run show <gh-issue-id> — Show detailed run state
 * grhs run retry <gh-issue-id> — Retry a failed run
 * grhs run cancel <gh-issue-id> — Cancel a pending/running run
 */

import { join } from "node:path";
import type { Command } from "commander";
import { loadConfig } from "../config.ts";
import { dispatchRun } from "../dispatcher.ts";
import {
	outputJson,
	printError,
	printRunFull,
	printRunOneLine,
	printSuccess,
	printWarning,
	setJsonMode,
} from "../output.ts";
import { appendRun, readAllRuns, updateRun, writeAllRuns } from "../state.ts";
import type { RunState } from "../types.ts";

/**
 * List runs with optional filters. Exported for testing.
 */
export async function listRuns(
	projectRoot: string,
	opts: { status?: string; repo?: string; limit: number },
): Promise<RunState[]> {
	let runs = await readAllRuns(projectRoot);
	if (opts.status) runs = runs.filter((r) => r.status === opts.status);
	if (opts.repo) runs = runs.filter((r) => r.ghRepo === opts.repo);
	return runs.slice(0, opts.limit);
}

/**
 * Find runs by GitHub issue ID. Exported for testing.
 */
export async function findRunsByIssueId(
	projectRoot: string,
	ghIssueId: number,
): Promise<RunState[]> {
	const runs = await readAllRuns(projectRoot);
	return runs.filter((r) => r.ghIssueId === ghIssueId);
}

/**
 * Cancel a pending or running run. Exported for testing.
 */
export async function cancelRun(projectRoot: string, ghIssueId: number): Promise<RunState> {
	const runs = await readAllRuns(projectRoot);
	const existing = runs.find((r) => r.ghIssueId === ghIssueId);

	if (!existing) {
		throw new Error(`No run found for issue #${ghIssueId}`);
	}
	if (existing.status !== "pending" && existing.status !== "running") {
		throw new Error(`Run for issue #${ghIssueId} cannot be cancelled (status: ${existing.status})`);
	}

	return updateRun(
		ghIssueId,
		existing.ghRepo,
		{ status: "failed", error: "cancelled" },
		projectRoot,
	);
}

/**
 * Reset a failed run to pending and attempt re-dispatch. Exported for testing.
 * Returns the final run state after the operation.
 */
export async function retryRun(
	projectRoot: string,
	ghIssueId: number,
	configPath?: string,
): Promise<RunState> {
	const runs = await readAllRuns(projectRoot);
	const existing = runs.find((r) => r.ghIssueId === ghIssueId);

	if (!existing) {
		throw new Error(`No run found for issue #${ghIssueId}`);
	}
	if (existing.status !== "failed") {
		throw new Error(`Run for issue #${ghIssueId} is not failed (status: ${existing.status})`);
	}

	// Reset to pending
	const reset = await updateRun(
		ghIssueId,
		existing.ghRepo,
		{ status: "pending", error: undefined, retryable: undefined },
		projectRoot,
	);

	// Attempt re-dispatch
	const resolvedConfigPath = configPath ?? join(projectRoot, ".greenhouse", "config.yaml");
	let config: Awaited<ReturnType<typeof loadConfig>> | undefined;
	try {
		config = await loadConfig(resolvedConfigPath);
	} catch {
		// Config unavailable — run is reset to pending, daemon will dispatch
		return reset;
	}

	const repoConfig = config.repos.find((r) => `${r.owner}/${r.repo}` === existing.ghRepo);
	if (!repoConfig) {
		return reset;
	}

	const dispatched = await dispatchRun(existing.seedsId, repoConfig);
	const dispatchedRun: RunState = {
		...reset,
		status: "running",
		agentName: dispatched.agentName,
		mergeBranch: dispatched.mergeBranch,
		dispatchedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	await appendRun(dispatchedRun, projectRoot);
	return dispatchedRun;
}

/**
 * Compact state.jsonl by removing terminal runs. Exported for testing.
 * Returns counts of removed and remaining entries.
 */
export async function cleanRuns(
	projectRoot: string,
	opts: { keepShipped?: boolean } = {},
): Promise<{ removed: number; remaining: number }> {
	const runs = await readAllRuns(projectRoot);
	const keep = runs.filter((r) => {
		if (r.status === "failed" && r.retryable !== true) return false;
		if (r.status === "shipped" && !opts.keepShipped) return false;
		return true;
	});
	await writeAllRuns(keep, projectRoot);
	return { removed: runs.length - keep.length, remaining: keep.length };
}

export function registerRunsCommand(program: Command): void {
	// grhs runs — list all tracked runs
	program
		.command("runs")
		.description("List all tracked runs")
		.option(
			"--status <status>",
			"Filter by status (pending|ingested|running|shipping|shipped|failed)",
		)
		.option("--repo <owner/repo>", "Filter by repo")
		.option("--limit <n>", "Max results", "20")
		.action(async (opts: { status?: string; repo?: string; limit: string }) => {
			const json = !!program.opts().json;
			if (json) setJsonMode(true);

			const limit = Number.parseInt(opts.limit, 10);
			const runs = await listRuns(process.cwd(), {
				status: opts.status,
				repo: opts.repo,
				limit,
			});

			if (json) {
				outputJson(runs);
			} else {
				if (runs.length === 0) {
					console.log("No runs found.");
					return;
				}
				for (const run of runs) {
					printRunOneLine(run);
				}
			}
		});

	// grhs run — subcommand group for individual run operations
	const run = program.command("run").description("Manage individual runs");

	run
		.command("show <gh-issue-id>")
		.description("Show detailed run state for a GitHub issue")
		.action(async (ghIssueIdStr: string) => {
			const json = !!program.opts().json;
			if (json) setJsonMode(true);

			const ghIssueId = Number.parseInt(ghIssueIdStr, 10);
			if (Number.isNaN(ghIssueId)) {
				printError(`Invalid issue ID: ${ghIssueIdStr}`);
				process.exitCode = 1;
				return;
			}

			const matches = await findRunsByIssueId(process.cwd(), ghIssueId);

			if (matches.length === 0) {
				const msg = `No run found for issue #${ghIssueId}`;
				if (json) outputJson({ error: msg });
				else printError(msg);
				process.exitCode = 1;
				return;
			}

			if (json) {
				outputJson(matches.length === 1 ? matches[0] : matches);
			} else {
				for (let i = 0; i < matches.length; i++) {
					if (i > 0) console.log();
					printRunFull(matches[i] as RunState);
				}
			}
		});

	run
		.command("retry <gh-issue-id>")
		.description("Retry a failed run")
		.action(async (ghIssueIdStr: string) => {
			const json = !!program.opts().json;
			if (json) setJsonMode(true);

			const ghIssueId = Number.parseInt(ghIssueIdStr, 10);
			if (Number.isNaN(ghIssueId)) {
				printError(`Invalid issue ID: ${ghIssueIdStr}`);
				process.exitCode = 1;
				return;
			}

			const projectRoot = process.cwd();
			const configPath = program.opts().config as string | undefined;

			try {
				const result = await retryRun(projectRoot, ghIssueId, configPath);
				if (json) {
					outputJson(result);
				} else if (result.status === "running") {
					printSuccess(`Retried run for #${ghIssueId} — agent: ${result.agentName ?? "unknown"}`);
				} else {
					printSuccess(`Reset run for #${ghIssueId} to pending`);
					printWarning("Could not re-dispatch — daemon will pick it up on next cycle");
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (json) outputJson({ error: msg });
				else printError(msg);
				process.exitCode = 1;
			}
		});

	run
		.command("cancel <gh-issue-id>")
		.description("Cancel a pending or running run")
		.action(async (ghIssueIdStr: string) => {
			const json = !!program.opts().json;
			if (json) setJsonMode(true);

			const ghIssueId = Number.parseInt(ghIssueIdStr, 10);
			if (Number.isNaN(ghIssueId)) {
				printError(`Invalid issue ID: ${ghIssueIdStr}`);
				process.exitCode = 1;
				return;
			}

			try {
				const result = await cancelRun(process.cwd(), ghIssueId);
				if (json) outputJson(result);
				else printSuccess(`Cancelled run for #${ghIssueId}`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (json) outputJson({ error: msg });
				else printError(msg);
				process.exitCode = 1;
			}
		});

	run
		.command("clean")
		.description("Compact state.jsonl by removing shipped and failed runs")
		.option("--keep-shipped", "Preserve shipped runs; only remove non-retryable failed runs")
		.action(async (opts: { keepShipped?: boolean }) => {
			const json = !!program.opts().json;
			if (json) setJsonMode(true);

			const result = await cleanRuns(process.cwd(), { keepShipped: opts.keepShipped });
			if (json) {
				outputJson(result);
			} else {
				printSuccess(`Removed ${result.removed} run(s), ${result.remaining} remaining`);
			}
		});
}
