/**
 * grhs logs — Show daemon logs
 */

import type { Command } from "commander";

export function registerLogsCommand(program: Command): void {
	program
		.command("logs")
		.description("Show daemon logs")
		.option("--follow", "Tail mode — stream new log entries as they appear")
		.option("--since <duration>", "Time filter (e.g. '1h', '30m')")
		.action((opts: { follow?: boolean; since?: string }) => {
			const logPath = ".greenhouse/daemon.log";
			if (opts.follow) {
				process.stdout.write(`Tailing ${logPath}`);
			} else {
				process.stdout.write(`Showing logs from ${logPath}`);
			}
			if (opts.since) process.stdout.write(` (since: ${opts.since})`);
			process.stdout.write("\n");
			// TODO: open .greenhouse/daemon.log, parse NDJSON lines, apply --since filter,
			//       format for TTY (human-readable) or passthrough (NDJSON when piped),
			//       if --follow: watch file for new lines and stream them
		});
}
