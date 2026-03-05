#!/usr/bin/env bun

/**
 * Greenhouse CLI — main entry point.
 *
 * Binary names: greenhouse (full), grhs (short alias)
 */

import { Command } from "commander";
import { registerConfigCommand } from "./commands/config.ts";
import { registerDoctorCommand } from "./commands/doctor.ts";
import { registerInitCommand } from "./commands/init.ts";
import { registerStartCommand } from "./commands/start.ts";
import { registerStatusCommand } from "./commands/status.ts";
import { registerStopCommand } from "./commands/stop.ts";

// TODO: uncomment when build-cli-ops agent delivers these files:
// import { registerRunsCommand } from "./commands/runs.ts";
// import { registerPollCommand } from "./commands/poll.ts";
// import { registerIngestCommand } from "./commands/ingest.ts";
// import { registerShipCommand } from "./commands/ship.ts";
// import { registerLogsCommand } from "./commands/logs.ts";
// import { registerBudgetCommand } from "./commands/budget.ts";

export const VERSION = "0.1.0";

const program = new Command();

program
	.name("greenhouse")
	.alias("grhs")
	.description(
		"Autonomous development daemon — polls GitHub, dispatches overstory runs, opens PRs.",
	)
	.version(VERSION, "-v, --version", "Print version")
	.option("--json", "JSON output")
	.option("--config <path>", "Config file path (default: .greenhouse/config.yaml)");

// --version --json
const rawArgs = process.argv.slice(2);
if ((rawArgs.includes("-v") || rawArgs.includes("--version")) && rawArgs.includes("--json")) {
	process.stdout.write(
		`${JSON.stringify({
			name: "@os-eco/greenhouse-cli",
			version: VERSION,
			runtime: "bun",
			platform: `${process.platform}-${process.arch}`,
		})}\n`,
	);
	process.exit(0);
}

// Register commands in scope
registerStartCommand(program);
registerStopCommand(program);
registerStatusCommand(program);
registerInitCommand(program);
registerConfigCommand(program);
registerDoctorCommand(program);

// TODO: register when build-cli-ops delivers:
// registerRunsCommand(program);
// registerPollCommand(program);
// registerIngestCommand(program);
// registerShipCommand(program);
// registerLogsCommand(program);
// registerBudgetCommand(program);

// Unknown command handler
program.on("command:*", (operands: string[]) => {
	const unknown = operands[0] ?? "";
	process.stderr.write(`Unknown command: ${unknown}\n`);
	process.stderr.write("Run 'grhs --help' for usage.\n");
	process.exitCode = 1;
});

async function main(): Promise<void> {
	await program.parseAsync(process.argv);
}

if (import.meta.main) {
	main().catch((err: unknown) => {
		const useJson = process.argv.includes("--json");
		if (err instanceof Error) {
			if (useJson) {
				process.stdout.write(`${JSON.stringify({ success: false, error: err.message })}\n`);
			} else {
				process.stderr.write(`Error: ${err.message}\n`);
			}
		} else {
			if (useJson) {
				process.stdout.write(`${JSON.stringify({ success: false, error: String(err) })}\n`);
			} else {
				process.stderr.write(`Unknown error: ${String(err)}\n`);
			}
		}
		process.exitCode = 1;
	});
}
