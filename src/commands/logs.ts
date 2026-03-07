/**
 * grhs logs — Show daemon logs
 */

import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import chalk from "chalk";
import type { Command } from "commander";
import { accent, muted } from "../output.ts";

interface LogEntry {
	ts?: string;
	level?: string;
	msg?: string;
	event?: string;
	agent?: string;
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

/** Extract HH:MM:SS from an ISO 8601 timestamp. */
function formatTime(iso: string): string {
	const match = iso.match(/T?(\d{2}:\d{2}:\d{2})/);
	return match ? (match[1] ?? iso) : iso;
}

/** Extract YYYY-MM-DD from an ISO 8601 timestamp. */
function extractDate(iso: string): string {
	return iso.slice(0, 10);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence stripping requires ESC (\u001b) literal
const ANSI_RE = /\u001b\[[0-9;]*m/g;

function visibleLength(str: string): number {
	return str.replace(ANSI_RE, "").length;
}

function padVisible(str: string, width: number): string {
	const visible = visibleLength(str);
	return visible >= width ? str : str + " ".repeat(width - visible);
}

const SEEDS_ID_RE = /^[a-z][a-z0-9]*-[a-z0-9]+$/;
const GH_ISSUE_RE = /^#\d+$/;

function highlightValue(v: unknown): string {
	const s = typeof v === "object" ? JSON.stringify(v) : String(v);
	if (SEEDS_ID_RE.test(s) || GH_ISSUE_RE.test(s)) {
		return accent(s);
	}
	const display = s.includes(" ") ? `"${s}"` : s;
	return muted(display);
}

const LEVEL_LABELS: Record<string, string> = {
	debug: chalk.gray.bold("DBG"),
	info: chalk.blue.bold("INF"),
	warn: chalk.yellow.bold("WRN"),
	error: chalk.red.bold("ERR"),
};

const EVENT_LABELS: Record<string, string> = {
	"run.ingested": chalk.green.bold("INGST"),
	"run.dispatched": chalk.magenta.bold("DSPCH"),
	"run.completed": chalk.cyan.bold("DONE "),
	"run.failed": chalk.red.bold("FAIL "),
	"poll.start": chalk.blue.bold("POLL+"),
	"poll.end": chalk.blue.bold("POLL-"),
	"supervisor.start": chalk.magenta.bold("SUPV+"),
	"supervisor.timeout": chalk.red.bold("TIMEO"),
	"budget.exceeded": chalk.yellow.bold("BUDGT"),
};

const EXTRA_SKIP_KEYS = new Set(["ts", "level", "msg", "agent", "event"]);

function formatEntry(raw: string): string {
	let entry: LogEntry;
	try {
		entry = JSON.parse(raw) as LogEntry;
	} catch {
		return raw;
	}

	if (!process.stdout.isTTY) return raw;

	const ts = entry.ts ? muted(formatTime(entry.ts)) : muted("?");

	const levelKey = entry.level ?? "";
	const levelLabel =
		LEVEL_LABELS[levelKey] ?? padVisible(chalk.bold(levelKey.toUpperCase().slice(0, 3)), 3);

	const eventKey = typeof entry.event === "string" ? entry.event : "";
	const eventLabel = eventKey && EVENT_LABELS[eventKey] ? ` ${EVENT_LABELS[eventKey]}` : "";

	const agentStr =
		typeof entry.agent === "string" && entry.agent ? muted(entry.agent) + muted(" | ") : "";

	const msg = entry.msg ?? "(no message)";

	const extraParts = Object.entries(entry)
		.filter(([k]) => !EXTRA_SKIP_KEYS.has(k))
		.map(([k, v]) => muted(`${k}=`) + highlightValue(v));
	const extra = extraParts.length > 0 ? ` ${extraParts.join(" ")}` : "";

	return `${ts} ${levelLabel}${eventLabel} ${agentStr}${msg}${extra}`;
}

function dateSeparator(date: string): string {
	return muted(`--- ${date} ---`);
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

		let lastDate = "";

		rl.on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;

			// Apply --since filter and extract date for separator
			let entryDate = "";
			try {
				const entry = JSON.parse(trimmed) as LogEntry;
				if (entry.ts) {
					if (sinceMs !== null) {
						const entryTime = new Date(entry.ts).getTime();
						if (Date.now() - entryTime > sinceMs) return;
					}
					entryDate = extractDate(entry.ts);
				}
			} catch {
				// Non-JSON line, include it
			}

			// Emit date separator when date changes
			if (process.stdout.isTTY && entryDate && entryDate !== lastDate) {
				process.stdout.write(`${dateSeparator(entryDate)}\n`);
				lastDate = entryDate;
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
	process.stdout.write(
		process.stdout.isTTY ? `${muted("--- following (Ctrl-C to stop) ---")}\n` : "",
	);

	let lastDate = "";

	const poll = async (): Promise<void> => {
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
						if (!trimmed) continue;

						// Date separator in follow mode
						if (process.stdout.isTTY) {
							try {
								const entry = JSON.parse(trimmed) as LogEntry;
								if (entry.ts) {
									const entryDate = extractDate(entry.ts);
									if (entryDate && entryDate !== lastDate) {
										process.stdout.write(`${dateSeparator(entryDate)}\n`);
										lastDate = entryDate;
									}
								}
							} catch {
								// non-JSON, skip separator logic
							}
						}

						process.stdout.write(`${formatEntry(trimmed)}\n`);
					}
				} finally {
					await fh.close();
				}
			}
		} catch {
			// Log file may not exist yet — keep polling
		}
		await new Promise((r) => setTimeout(r, 500));
		await poll();
	};

	await poll();
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
						process.stdout.isTTY
							? `${muted(`Log file not found: ${logPath}\nWaiting for daemon to start...`)}\n`
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
