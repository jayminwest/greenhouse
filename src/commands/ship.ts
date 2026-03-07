/**
 * grhs ship <seeds-id> — Guardrailed shipping gateway
 *
 * Single entrypoint for shipping completed runs. Runs pre-flight checks
 * (quality gates, orphaned worktrees, stale locks) before pushing to origin
 * and creating a GitHub PR.
 */

import { join } from "node:path";
import type { Command } from "commander";
import { loadConfig } from "../config.ts";
import { defaultExec } from "../exec.ts";
import { outputJson, printError, printInfo, printSuccess, printWarning } from "../output.ts";
import { cleanupAfterShip, shipRun } from "../shipper.ts";
import { readAllRuns, updateRun } from "../state.ts";

/**
 * Find a run by seeds ID. Returns undefined if not found.
 */
export async function findRunBySeedsId(
	projectRoot: string,
	seedsId: string,
): Promise<import("../types.ts").RunState | undefined> {
	const runs = await readAllRuns(projectRoot);
	return runs.find((r) => r.seedsId === seedsId);
}

export function registerShipCommand(program: Command): void {
	program
		.command("ship <seeds-id>")
		.description(
			"Ship a completed run — push merge branch and open PR (guardrailed shipping gateway)",
		)
		.option("--config <path>", "Config file path", ".greenhouse/config.yaml")
		.option("--skip-preflight", "Skip pre-flight quality gate checks (use with caution)")
		.option("--no-cleanup", "Skip post-ship branch cleanup")
		.action(
			async (
				seedsId: string,
				opts: { config: string; skipPreflight?: boolean; cleanup: boolean },
			) => {
				const json = !!program.opts().json;
				const cwd = process.cwd();

				// Load config
				let config: Awaited<ReturnType<typeof loadConfig>>;
				try {
					config = await loadConfig(join(cwd, opts.config));
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					if (json) outputJson({ success: false, error: msg });
					else printError(msg);
					process.exitCode = 1;
					return;
				}

				// Find the run
				const run = await findRunBySeedsId(cwd, seedsId);
				if (!run) {
					const msg = `No run found for seeds ID: ${seedsId}`;
					if (json) outputJson({ success: false, error: msg });
					else printError(msg);
					process.exitCode = 1;
					return;
				}

				if (run.status === "shipped") {
					const msg = `Run ${seedsId} is already shipped (PR: ${run.prUrl ?? "unknown"})`;
					if (json) outputJson({ success: false, error: msg });
					else printWarning(msg);
					return;
				}

				// Find repo config
				const repoConfig = config.repos.find((r) => `${r.owner}/${r.repo}` === run.ghRepo);
				if (!repoConfig) {
					const msg = `No repo config found for ${run.ghRepo}`;
					if (json) outputJson({ success: false, error: msg });
					else printError(msg);
					process.exitCode = 1;
					return;
				}

				if (!json) printInfo(`Shipping ${seedsId} (${run.ghTitle})...`);

				// Mark as shipping
				await updateRun(run.ghIssueId, run.ghRepo, { status: "shipping" }, cwd);

				// Ship
				let prUrl: string;
				let prNumber: number;
				try {
					const result = await shipRun(run, repoConfig, config, defaultExec);
					prUrl = result.prUrl;
					prNumber = result.prNumber;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);

					// Revert status to previous on failure
					await updateRun(
						run.ghIssueId,
						run.ghRepo,
						{ status: run.status, error: msg, retryable: true },
						cwd,
					).catch(() => undefined);

					if (json) outputJson({ success: false, error: msg });
					else printError(`Ship failed: ${msg}`);
					process.exitCode = 1;
					return;
				}

				// Update state to shipped
				await updateRun(
					run.ghIssueId,
					run.ghRepo,
					{
						status: "shipped",
						prUrl,
						prNumber,
						shippedAt: new Date().toISOString(),
					},
					cwd,
				);

				// Post-ship cleanup
				if (opts.cleanup !== false) {
					const shipped = { ...run, prUrl, prNumber };
					await cleanupAfterShip(shipped, repoConfig, defaultExec).catch((err: unknown) => {
						const msg = err instanceof Error ? err.message : String(err);
						if (!json) printWarning(`Cleanup warning: ${msg}`);
					});
				}

				if (json) {
					outputJson({ success: true, seedsId, prUrl, prNumber });
				} else {
					printSuccess(`Shipped ${seedsId} → ${prUrl}`);
				}
			},
		);
}
