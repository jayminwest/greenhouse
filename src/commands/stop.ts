/**
 * grhs stop — Stop a detached daemon
 */

import type { Command } from "commander";

export function registerStopCommand(program: Command): void {
	program
		.command("stop")
		.description("Stop a detached daemon")
		.option("--force", "Kill immediately (SIGKILL vs SIGTERM)")
		.action((opts: { force?: boolean }) => {
			const signal = opts.force ? "SIGKILL" : "SIGTERM";
			process.stdout.write(`Stopping greenhouse daemon with ${signal}...\n`);
			// TODO: implement stop logic — read .greenhouse/daemon.pid and send signal
		});
}
