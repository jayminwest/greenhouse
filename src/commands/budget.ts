/**
 * grhs budget — Show daily budget status
 */

import type { Command } from "commander";

export function registerBudgetCommand(program: Command): void {
	program
		.command("budget")
		.description("Show daily budget status (issues dispatched vs. daily cap)")
		.option("--reset", "Reset daily counter (emergency use)")
		.action((opts: { reset?: boolean }) => {
			if (opts.reset) {
				process.stdout.write("Resetting daily budget counter...\n");
				// TODO: read config for cap, write today's budget entry with dispatched: 0
			} else {
				process.stdout.write("Daily budget status:\n");
				// TODO: read .greenhouse/state.jsonl, count dispatched today,
				//       read config for daily_cap, display remaining budget
			}
		});
}
