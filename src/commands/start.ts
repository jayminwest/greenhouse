/**
 * grhs start — Start the greenhouse daemon
 */

import type { Command } from "commander";

export function registerStartCommand(program: Command): void {
	program
		.command("start")
		.description("Start the daemon (foreground)")
		.option("--detach", "Run in background (writes PID file)")
		.option("--config <path>", "Config file path", ".greenhouse/config.yaml")
		.action((opts: { detach?: boolean; config: string }) => {
			const mode = opts.detach ? "detached" : "foreground";
			process.stdout.write(`Starting greenhouse daemon in ${mode} mode...\n`);
			process.stdout.write(`Config: ${opts.config}\n`);
			// TODO: implement daemon.ts and wire up here
		});
}
