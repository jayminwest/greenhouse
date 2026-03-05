/**
 * grhs status — Show daemon state
 */

import type { Command } from "commander";

export function registerStatusCommand(program: Command): void {
	program
		.command("status")
		.description("Show daemon state (running/stopped, current runs, daily budget, next poll)")
		.action(() => {
			process.stdout.write("Greenhouse daemon status: not implemented yet\n");
			// TODO: check .greenhouse/daemon.pid, read state.jsonl, compute daily budget
		});
}
