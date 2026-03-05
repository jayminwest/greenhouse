/**
 * grhs budget — Show daily budget status
 */

import { join } from "node:path";
import type { Command } from "commander";
import { getDailyBudget } from "../budget.ts";
import { loadConfig } from "../config.ts";
import { outputJson, printBudget, printError, printSuccess } from "../output.ts";
import { readAllRuns, writeAllRuns } from "../state.ts";
import type { DaemonConfig } from "../types.ts";

export function registerBudgetCommand(program: Command): void {
	program
		.command("budget")
		.description("Show daily budget status (issues dispatched vs. daily cap)")
		.option("--config <path>", "Config file path", ".greenhouse/config.yaml")
		.option("--reset", "Reset daily counter (emergency use)")
		.action(async (opts: { config: string; reset?: boolean }) => {
			const useJson = (program.opts() as { json?: boolean }).json ?? false;
			const configPath = join(process.cwd(), opts.config);

			let config: DaemonConfig;
			try {
				config = await loadConfig(configPath);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (useJson) {
					outputJson({ success: false, error: msg });
				} else {
					printError(msg);
				}
				process.exitCode = 1;
				return;
			}

			const projectRoot = process.cwd();
			const today = new Date().toISOString().slice(0, 10);

			if (opts.reset) {
				const runs = await readAllRuns(projectRoot);
				const updated = runs.map((r) => {
					if (r.dispatchedAt && r.dispatchedAt.slice(0, 10) === today) {
						const { dispatchedAt: _, ...rest } = r;
						return rest as typeof r;
					}
					return r;
				});
				await writeAllRuns(updated, projectRoot);
				const budget = await getDailyBudget(config.daily_cap, projectRoot);
				if (useJson) {
					outputJson({ success: true, reset: true, budget });
				} else {
					printSuccess("Daily budget counter reset");
					printBudget(budget);
				}
				return;
			}

			const budget = await getDailyBudget(config.daily_cap, projectRoot);
			if (useJson) {
				outputJson({ success: true, budget });
			} else {
				printBudget(budget);
			}
		});
}
