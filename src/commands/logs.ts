/**
 * grhs logs — Show daemon logs
 */

import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Command } from "commander";

interface LogEntry {
	ts?: string;
	level?: string;
	msg?: string;
	[key: string]: unknown;
}

/** Parse a duration string like "1h", "30m", "90s" into milliseconds. */
function parseDurationMs(dur: string): number | null {
	const m = /^(\d+)(h|m|s)$/.exec(dur.trim());
	if (!m) return null;
	const n = Number.parseInt(m[1] ?? "0", 10);
	switch (m[2]) {
		case "h":
			return n * 3600 * 1000;
		case "m":
			return n * 60 * 1000;
		case "s":
			return n * 1000;
		default:
			return null;
	}
}

const LEVEL_COLORS: Record<string, string> = {
	error: "\x1b[31m",
	warn: "\x1b[33m",
	info: "\x1b[36m",
	debug: "\x1b[90m",
};
const RESET = "\x1b[0m";

function isTTY(): boolean {
	return process.stdout.isTTY === true;
}

function formatEntry(raw: string): string {
	let entry: LogEntry;
	try {
		entry = JSON.parse(raw) as LogEntry;
	} catch {
		return raw;
	}

	if (!isTTY()) return raw;

	const ts = entry.ts ? new Date(entry.ts).toLocaleTimeString() : "?";
	const level = (entry.level ?? "?").padEnd(5);
	const color = LEVEL_COLORS[entry.level ?? ""] ?? "";
	const msg = entry.msg ?? "(no message)";

	// Extra fields (excluding ts, level, msg)
	const extra = Object.entries(entry)
		.filter(([k]) => k !== "ts" && k !== "level" && k !== "msg")
		.map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
		.join(" ");

	return `${color}${ts} [${level}] ${msg}${extra ? ` ${extra}` : ""}${RESET}`;
}

async function readAndPrintLines(logPath: string, sinceMs: number | null): Promise<number> {
	let fileSize = 0;
	try {
		const st = await stat(logPath);
		fileSize = st.size;
	} catch {
		return 0;
	}

	return new Promise<number>((resolve, reject) => {
		const stream = createReadStream(logPath, { encoding: "utf8" });
		const rl = createInterface({ input: stream, crlfDelay: Infinity });

		rl.on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;

			// Apply --since filter
			if (sinceMs !== null) {
				try {
					const entry = JSON.parse(trimmed) as LogEntry;
					if (entry.ts) {
						const entryTime = new Date(entry.ts).getTime();
						if (Date.now() - entryTime > sinceMs) return;
					}
				} catch {
					// Non-JSON line, include it
				}
			}

			process.stdout.write(`${formatEntry(trimmed)}\n`);
		});

		rl.on("close", () => resolve(fileSize));
		rl.on("error", reject);
		stream.on("error", reject);
	});
}

async function followLog(logPath: string, startOffset: number): Promise<void> {
	// Poll-based tail: check for new bytes every 500ms
	let offset = startOffset;
	process.stdout.write(isTTY() ? "\x1b[90m--- following (Ctrl-C to stop) ---\x1b[0m\n" : "");

	while (true) {
		try {
			const st = await stat(logPath);
			if (st.size > offset) {
				const fh = await open(logPath, "r");
				try {
					const buf = Buffer.allocUnsafe(st.size - offset);
					const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
					offset += bytesRead;
					const chunk = buf.slice(0, bytesRead).toString("utf8");
					for (const line of chunk.split("\n")) {
						const trimmed = line.trim();
						if (trimmed) process.stdout.write(`${formatEntry(trimmed)}\n`);
					}
				} finally {
					await fh.close();
				}
			}
		} catch {
			// Log file may not exist yet — keep polling
		}
		await new Promise((r) => setTimeout(r, 500));
	}
}

export function registerLogsCommand(program: Command): void {
	program
		.command("logs")
		.description("Show daemon logs")
		.option("--follow", "Tail mode — stream new log entries as they appear")
		.option("--since <duration>", "Time filter (e.g. '1h', '30m')")
		.action(async (opts: { follow?: boolean; since?: string }) => {
			const logPath = join(process.cwd(), ".greenhouse", "daemon.log");

			// Validate --since
			let sinceMs: number | null = null;
			if (opts.since) {
				sinceMs = parseDurationMs(opts.since);
				if (sinceMs === null) {
					process.stderr.write(
						`Error: invalid --since value "${opts.since}". Use format like "1h", "30m", "90s".\n`,
					);
					process.exitCode = 1;
					return;
				}
			}

			// Check if log file exists
			try {
				await stat(logPath);
			} catch {
				if (opts.follow) {
					process.stdout.write(
						isTTY()
							? `\x1b[90mLog file not found: ${logPath}\nWaiting for daemon to start...\x1b[0m\n`
							: `Log file not found: ${logPath}\n`,
					);
					await followLog(logPath, 0);
					return;
				}
				process.stderr.write(
					`Log file not found: ${logPath}\nStart the daemon with \`grhs start\`.\n`,
				);
				process.exitCode = 1;
				return;
			}

			const endOffset = await readAndPrintLines(logPath, sinceMs);

			if (opts.follow) {
				await followLog(logPath, endOffset);
			}
		});
}
