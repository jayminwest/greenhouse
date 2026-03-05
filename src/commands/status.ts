/**
 * grhs status — Show daemon state
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { computeBudget } from "../budget.ts";
import { loadConfig } from "../config.ts";
import { getActiveRuns, readAllRuns } from "../state.ts";
import type { DaemonConfig, RunState } from "../types.ts";

interface PidEntry {
	pid: number;
	startedAt?: string;
}

async function readPidFile(pidPath: string): Promise<PidEntry | null> {
	try {
		const raw = (await readFile(pidPath, "utf8")).trim();
		// Support both plain "12345" and JSON {pid, startedAt}
		if (raw.startsWith("{")) {
			const parsed = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown };
			if (typeof parsed.pid === "number") {
				return {
					pid: parsed.pid,
					startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
				};
			}
		} else {
			const n = Number.parseInt(raw, 10);
			if (!Number.isNaN(n)) return { pid: n };
		}
	} catch {
		// File missing or unreadable — daemon not running
	}
	return null;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function formatNextPoll(startedAt: string, pollIntervalMinutes: number): string {
	const started = new Date(startedAt).getTime();
	const intervalMs = pollIntervalMinutes * 60 * 1000;
	const now = Date.now();
	const elapsed = (now - started) % intervalMs;
	const remaining = intervalMs - elapsed;
	const minutes = Math.floor(remaining / 60000);
	const seconds = Math.floor((remaining % 60000) / 1000);
	if (minutes === 0) return `${seconds}s`;
	return `${minutes}m ${seconds}s`;
}

function summarizeRuns(runs: RunState[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const r of runs) {
		counts[r.status] = (counts[r.status] ?? 0) + 1;
	}
	return counts;
}

interface StatusOutput {
	daemon: {
		running: boolean;
		pid?: number;
		startedAt?: string;
	};
	budget: {
		date: string;
		dispatched: number;
		cap: number;
		remaining: number;
	};
	activeRuns: number;
	runsByStatus: Record<string, number>;
	nextPollIn?: string;
	config?: {
		pollIntervalMinutes: number;
		dailyCap: number;
		repos: string[];
	};
}

export function registerStatusCommand(program: Command): void {
	program
		.command("status")
		.description("Show daemon state (running/stopped, current runs, daily budget, next poll)")
		.option("--json", "Output as JSON")
		.option("--config <path>", "Config file path", ".greenhouse/config.yaml")
		.action(async (opts: { json?: boolean; config: string }) => {
			const projectRoot = process.cwd();
			const pidPath = join(projectRoot, ".greenhouse", "daemon.pid");

			// Check daemon status
			const pidEntry = await readPidFile(pidPath);
			const daemonRunning = pidEntry !== null && isProcessAlive(pidEntry.pid);

			// Load config (best-effort)
			let config: DaemonConfig | null = null;
			try {
				config = await loadConfig(join(projectRoot, opts.config));
			} catch {
				// Config missing — proceed with partial output
			}

			// Read runs
			let allRuns: RunState[] = [];
			let activeRuns: RunState[] = [];
			if (config) {
				for (const repo of config.repos) {
					const repoRuns = await readAllRuns(repo.project_root);
					allRuns = allRuns.concat(repoRuns);
					const repoActive = await getActiveRuns(repo.project_root);
					activeRuns = activeRuns.concat(repoActive);
				}
			}

			// Budget
			const dailyCap = config?.daily_cap ?? 5;
			const budget = computeBudget(allRuns, dailyCap);

			// Next poll
			const nextPollIn =
				daemonRunning && config && pidEntry?.startedAt
					? formatNextPoll(pidEntry.startedAt, config.poll_interval_minutes)
					: undefined;

			const output: StatusOutput = {
				daemon: {
					running: daemonRunning,
					pid: daemonRunning && pidEntry ? pidEntry.pid : undefined,
					startedAt: daemonRunning && pidEntry?.startedAt ? pidEntry.startedAt : undefined,
				},
				budget,
				activeRuns: activeRuns.length,
				runsByStatus: summarizeRuns(allRuns),
				nextPollIn,
				config: config
					? {
							pollIntervalMinutes: config.poll_interval_minutes,
							dailyCap: config.daily_cap,
							repos: config.repos.map((r) => `${r.owner}/${r.repo}`),
						}
					: undefined,
			};

			if (opts.json) {
				process.stdout.write(`${JSON.stringify(output)}\n`);
				return;
			}

			// Human-readable output
			const daemonLine = daemonRunning
				? `running (pid ${pidEntry?.pid}${pidEntry?.startedAt ? `, started ${new Date(pidEntry.startedAt).toLocaleString()}` : ""})`
				: "stopped";

			process.stdout.write(`Daemon:   ${daemonLine}\n`);
			process.stdout.write(
				`Budget:   ${budget.dispatched}/${budget.cap} dispatched today (${budget.remaining} remaining)\n`,
			);
			process.stdout.write(`Active:   ${activeRuns.length} run(s) in progress\n`);

			if (Object.keys(output.runsByStatus).length > 0) {
				const summary = Object.entries(output.runsByStatus)
					.map(([s, n]) => `${n} ${s}`)
					.join(", ");
				process.stdout.write(`Runs:     ${summary}\n`);
			}

			if (nextPollIn !== undefined) {
				process.stdout.write(`Next poll: in ${nextPollIn}\n`);
			} else if (config) {
				process.stdout.write(`Poll interval: every ${config.poll_interval_minutes}m\n`);
			}

			if (!config) {
				process.stdout.write(`Config:   not found (run \`grhs init\` to create)\n`);
			}
		});
}
