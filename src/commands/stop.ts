/**
 * grhs stop — Stop a detached daemon
 */

import type { Command } from "commander";
import { isProcessAlive, pidFilePath, readPid, removePid } from "../pid.ts";

export function registerStopCommand(program: Command): void {
	program
		.command("stop")
		.description("Stop a detached daemon")
		.option("--force", "Kill immediately (SIGKILL vs SIGTERM)")
		.action(async (opts: { force?: boolean }) => {
			const pidPath = pidFilePath();
			const pid = await readPid(pidPath);

			if (pid === null) {
				process.stderr.write("No PID file found. Is the daemon running?\n");
				process.exitCode = 1;
				return;
			}

			if (!isProcessAlive(pid)) {
				process.stderr.write(`PID ${pid} is not alive. Removing stale PID file.\n`);
				await removePid(pidPath);
				process.exitCode = 1;
				return;
			}

			if (opts.force) {
				process.kill(pid, "SIGKILL");
				await removePid(pidPath);
				process.stdout.write(`Daemon killed (PID ${pid}).\n`);
				return;
			}

			process.stdout.write(`Sending SIGTERM to daemon (PID ${pid})...\n`);
			process.kill(pid, "SIGTERM");

			// Wait up to 10s for graceful exit
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 250));
				if (!isProcessAlive(pid)) {
					await removePid(pidPath);
					process.stdout.write("Daemon stopped.\n");
					return;
				}
			}

			process.stderr.write("Daemon did not stop within 10s. Use --force to kill.\n");
			process.exitCode = 1;
		});
}
