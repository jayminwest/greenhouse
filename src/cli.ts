#!/usr/bin/env bun

/**
 * Greenhouse CLI — main entry point.
 *
 * Binary names: greenhouse (full), grhs (short alias)
 */

import chalk from "chalk";
import { Command } from "commander";
import { registerBudgetCommand } from "./commands/budget.ts";
import { registerConfigCommand } from "./commands/config.ts";
import { registerDoctorCommand } from "./commands/doctor.ts";
import { registerIngestCommand } from "./commands/ingest.ts";
import { registerInitCommand } from "./commands/init.ts";
import { registerLogsCommand } from "./commands/logs.ts";
import { registerPollCommand } from "./commands/poll.ts";
import { registerRunsCommand } from "./commands/runs.ts";
import { registerShipCommand } from "./commands/ship.ts";
import { registerStartCommand } from "./commands/start.ts";
import { registerStatusCommand } from "./commands/status.ts";
import { registerStopCommand } from "./commands/stop.ts";
import {
	brand,
	muted,
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
	.option("--quiet", "Suppress non-essential output (only errors and JSON)")
	.option("--verbose", "Enable debug-level output for troubleshooting")
	.option("--timing", "Print elapsed time after command completes")
	.addHelpCommand(false)
	.configureHelp({
		formatHelp(cmd, helper): string {
			const COL_WIDTH = 20;
			const lines: string[] = [];

			// Header: "greenhouse v0.1.2 — Autonomous development daemon"
			lines.push(
				`${brand.bold(cmd.name())} ${muted(`v${VERSION}`)} — Autonomous development daemon`,
			);
			lines.push("");

			// Usage
			lines.push(`Usage: ${chalk.dim("grhs")} <command> [options]`);
			lines.push("");

			// Commands
			const visibleCmds = helper.visibleCommands(cmd);
			if (visibleCmds.length > 0) {
				lines.push("Commands:");
				for (const sub of visibleCmds) {
					const term = helper.subcommandTerm(sub);
					const firstSpace = term.indexOf(" ");
					const name = firstSpace >= 0 ? term.slice(0, firstSpace) : term;
					const args = firstSpace >= 0 ? ` ${term.slice(firstSpace + 1)}` : "";
					const coloredTerm = `${chalk.green(name)}${args ? chalk.dim(args) : ""}`;
					const rawLen = term.length;
					const padding = " ".repeat(Math.max(2, COL_WIDTH - rawLen));
					lines.push(`  ${coloredTerm}${padding}${helper.subcommandDescription(sub)}`);
				}
				lines.push("");
			}

			// Options
			const visibleOpts = helper.visibleOptions(cmd);
			if (visibleOpts.length > 0) {
				lines.push("Options:");
				for (const opt of visibleOpts) {
					const flags = helper.optionTerm(opt);
					const padding = " ".repeat(Math.max(2, COL_WIDTH - flags.length));
					lines.push(`  ${chalk.dim(flags)}${padding}${helper.optionDescription(opt)}`);
				}
				lines.push("");
			}

			// Footer
			lines.push(`Run '${chalk.dim("grhs")} <command> --help' for command-specific help.`);

			return `${lines.join("\n")}\n`;
		},
	});

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
registerShipCommand(program);
registerPollCommand(program);
registerIngestCommand(program);
registerLogsCommand(program);
registerBudgetCommand(program);

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
