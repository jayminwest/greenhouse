#!/usr/bin/env bun

/**
 * Greenhouse CLI — main entry point.
 *
 * Binary names: greenhouse (full), grhs (short alias)
 */

import { Command } from "commander";
import { registerBudgetCommand } from "./commands/budget.ts";
import { registerCompletionsCommand } from "./commands/completions.ts";
import { registerConfigCommand } from "./commands/config.ts";
import { registerDoctorCommand } from "./commands/doctor.ts";
import { registerIngestCommand } from "./commands/ingest.ts";
import { registerInitCommand } from "./commands/init.ts";
import { registerLogsCommand } from "./commands/logs.ts";
import { registerPollCommand } from "./commands/poll.ts";
import { registerRunsCommand } from "./commands/runs.ts";
import { registerStartCommand } from "./commands/start.ts";
import { registerStatusCommand } from "./commands/status.ts";
import { registerStopCommand } from "./commands/stop.ts";
import { registerUpgradeCommand } from "./commands/upgrade.ts";
import {
	printElapsed,
	setJsonMode,
	setQuietMode,
	setTimingMode,
	setVerboseMode,
	startTiming,
} from "./output.ts";

export const VERSION = "0.1.2";

const program = new Command();

program
	.name("greenhouse")
	.alias("grhs")
	.description(
		"Autonomous development daemon — polls GitHub, dispatches overstory runs, opens PRs.",
	)
	.version(VERSION, "-v, --version", "Print version")
	.option("--json", "JSON output")
	.option("--config <path>", "Config file path (default: .greenhouse/config.yaml)")
	.option("-q, --quiet", "Suppress non-essential output (only errors and JSON)")
	.option("--verbose", "Enable debug-level output for troubleshooting")
	.option("--timing", "Print elapsed time after command completes");

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

// Wire up global option state before any command action runs
program.hook("preAction", () => {
	const opts = program.opts<{
		json?: boolean;
		quiet?: boolean;
		verbose?: boolean;
		timing?: boolean;
	}>();
	setJsonMode(opts.json ?? false);
	setQuietMode(opts.quiet ?? false);
	setVerboseMode(opts.verbose ?? false);
	setTimingMode(opts.timing ?? false);
	if (opts.timing) startTiming();
});

// Print elapsed time after command completes when --timing is set
program.hook("postAction", () => {
	printElapsed();
});

// Register commands in scope
registerStartCommand(program);
registerStopCommand(program);
registerStatusCommand(program);
registerInitCommand(program);
registerConfigCommand(program);
registerDoctorCommand(program);

registerRunsCommand(program);
registerPollCommand(program);
registerIngestCommand(program);
registerLogsCommand(program);
registerBudgetCommand(program);
registerCompletionsCommand(program);
registerUpgradeCommand(program);

function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	let prevRow: number[] = Array.from({ length: n + 1 }, (_, j) => j);
	for (let i = 1; i <= m; i++) {
		const currRow: number[] = [i];
		for (let j = 1; j <= n; j++) {
			const del = (prevRow[j] ?? 0) + 1;
			const ins = (currRow[j - 1] ?? 0) + 1;
			const sub = (prevRow[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
			currRow.push(Math.min(del, ins, sub));
		}
		prevRow = currRow;
	}
	return prevRow[n] ?? 0;
}

async function main(): Promise<void> {
	// Typo suggestions for unknown commands
	const firstArg = process.argv[2];
	if (firstArg && !firstArg.startsWith("-")) {
		const knownNames = program.commands.map((c) => c.name());
		if (!knownNames.includes(firstArg)) {
			let best = "";
			let bestDist = Number.POSITIVE_INFINITY;
			for (const name of knownNames) {
				const d = levenshtein(firstArg, name);
				if (d < bestDist) {
					bestDist = d;
					best = name;
				}
			}
			if (bestDist <= 2) {
				process.stderr.write(`Unknown command: ${firstArg}. Did you mean ${best}?\n`);
			} else {
				process.stderr.write(`Unknown command: ${firstArg}\nRun 'grhs --help' for usage.\n`);
			}
			process.exitCode = 1;
			return;
		}
	}
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
