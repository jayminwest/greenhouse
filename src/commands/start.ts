/**
 * grhs start — Start the greenhouse daemon
 */

import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { loadConfig } from "../config.ts";
import { runDaemon } from "../daemon.ts";
import { isProcessAlive, pidFilePath, readPid, removePid, writePid } from "../pid.ts";
import { GREENHOUSE_DIR } from "../types.ts";

export function registerStartCommand(program: Command): void {
	program
		.command("start")
		.description("Start the daemon (foreground)")
		.option("--detach", "Run in background (writes PID file)")
		.option("--config <path>", "Config file path")
		.action(async (opts: { detach?: boolean; config?: string }) => {
			const pidPath = pidFilePath();
			const existingPid = await readPid(pidPath);
			if (existingPid !== null) {
				if (isProcessAlive(existingPid)) {
					process.stderr.write(`Daemon already running (PID ${existingPid})\n`);
					process.exitCode = 1;
					return;
				} else {
					await removePid(pidPath);
				}
			}

			const config = await loadConfig(opts.config);

			if (opts.detach) {
				await mkdir(GREENHOUSE_DIR, { recursive: true });
				const logPath = join(GREENHOUSE_DIR, "daemon.log");
				const logFd = openSync(logPath, "a");
				const args = process.argv.slice(1).filter((a) => a !== "--detach");
				const child = spawn(process.execPath, args, {
					detached: true,
					stdio: ["ignore", logFd, logFd],
				});
				child.unref();
				const childPid = child.pid;
				if (childPid === undefined) {
					process.stderr.write("Failed to spawn daemon process.\n");
					process.exitCode = 1;
					return;
				}
				await writePid(pidPath, childPid);
				process.stdout.write(`Daemon started (PID ${childPid}), logging to ${logPath}\n`);
				return;
			} else {
				// Foreground mode: run daemon; on clean exit remove PID if we wrote one
				try {
					await runDaemon(config, opts.config);
				} finally {
					await removePid(pidPath);
				}
			}
		});
}
