/**
 * grhs ship <seeds-task-id> — Manually push + PR for a completed run
 */

import type { Command } from "commander";

export function registerShipCommand(program: Command): void {
	program
		.command("ship <seeds-task-id>")
		.description("Manually push branch and create PR for a completed run")
		.option("--config <path>", "Config file path", ".greenhouse/config.yaml")
		.action((seedsTaskId: string, opts: { config: string }) => {
			process.stdout.write(`Shipping run for seeds task: ${seedsTaskId}\n`);
			process.stdout.write(`Config: ${opts.config}\n`);
			// TODO: look up run by seedsId in state.jsonl, call shipper.ship(run, config),
			//       update state to "shipped", comment on GH issue with PR URL
		});
}
