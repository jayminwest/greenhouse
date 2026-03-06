/**
 * grhs ship <seeds-task-id> — Manually push + PR for a completed run
 */

import { join } from "node:path";
import type { Command } from "commander";
import { loadConfig } from "../config.ts";
import {
	isJsonMode,
	outputJson,
	printError,
	printInfo,
	printSuccess,
	setJsonMode,
} from "../output.ts";
import { shipRun } from "../shipper.ts";
import { readAllRuns, updateRun } from "../state.ts";

export function registerShipCommand(program: Command): void {
	program
		.command("ship <seeds-task-id>")
		.description("Manually push branch and create PR for a completed run")
		.option("--config <path>", "Config file path", ".greenhouse/config.yaml")
		.action(async (seedsTaskId: string, opts: { config: string }) => {
			setJsonMode((program.opts() as { json?: boolean }).json ?? false);
			const projectRoot = process.cwd();
			const configPath = join(projectRoot, opts.config);

			let config: Awaited<ReturnType<typeof loadConfig>>;
			try {
				config = await loadConfig(configPath);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (isJsonMode()) {
					outputJson({ success: false, error: msg });
				} else {
					printError(`Error loading config: ${msg}`);
				}
				process.exitCode = 1;
				return;
			}

			const runs = await readAllRuns(projectRoot);
			const run = runs.find((r) => r.seedsId === seedsTaskId);

			if (!run) {
				const msg = `No run found for seeds task: ${seedsTaskId}`;
				if (isJsonMode()) {
					outputJson({ success: false, error: msg });
				} else {
					printError(msg);
				}
				process.exitCode = 1;
				return;
			}

			if (run.status !== "running" && run.status !== "shipping") {
				const msg = `Run ${seedsTaskId} has status '${run.status}' — expected 'running' or 'shipping'`;
				if (isJsonMode()) {
					outputJson({ success: false, error: msg });
				} else {
					printError(msg);
				}
				process.exitCode = 1;
				return;
			}

			const repo = config.repos.find((r) => `${r.owner}/${r.repo}` === run.ghRepo);
			if (!repo) {
				const msg = `No repo config found for ${run.ghRepo}`;
				if (isJsonMode()) {
					outputJson({ success: false, error: msg });
				} else {
					printError(msg);
				}
				process.exitCode = 1;
				return;
			}

			printInfo(`Shipping run for seeds task: ${seedsTaskId}`);

			let prUrl: string;
			let prNumber: number;
			try {
				const result = await shipRun(run, repo, config);
				prUrl = result.prUrl;
				prNumber = result.prNumber;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (isJsonMode()) {
					outputJson({ success: false, error: msg });
				} else {
					printError(`Ship failed: ${msg}`);
				}
				process.exitCode = 1;
				return;
			}

			await updateRun(
				run.ghIssueId,
				run.ghRepo,
				{
					status: "shipped",
					prUrl,
					prNumber,
					shippedAt: new Date().toISOString(),
				},
				projectRoot,
			);

			if (isJsonMode()) {
				outputJson({ success: true, seedsTaskId, prUrl, prNumber });
			} else {
				printSuccess(`PR created: ${prUrl}`);
			}
		});
}
