/**
 * grhs poll — Run one poll cycle (don't start daemon)
 *
 * Useful for testing and one-off runs.
 */

import type { Command } from "commander";

export function registerPollCommand(program: Command): void {
	program
		.command("poll")
		.description("Run one poll cycle without starting the daemon (useful for testing)")
		.option("--config <path>", "Config file path", ".greenhouse/config.yaml")
		.action((opts: { config: string }) => {
			process.stdout.write(`Running one poll cycle (config: ${opts.config})...\n`);
			// TODO: load config, run poller.poll() once, ingest new issues, dispatch if budget allows
		});
}
