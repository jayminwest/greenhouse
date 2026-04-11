import { appendFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { defaultExec } from "./exec.ts";
import { pidFilePath, removePid, writePid } from "./pid.ts";
import { cleanupAfterShip } from "./shipper.ts";
import { readAllRuns } from "./state.ts";
import type { DaemonConfig, ExecFn, RunState } from "./types.ts";

/** Path to the daemon log file, set by initLogFile(). */
let _logFilePath: string | null = null;

/**
 * Initialize the log file path and ensure the .greenhouse/ directory exists.
 * Must be called before the first log() call in runDaemon().
 */
export async function initLogFile(projectRoot: string): Promise<void> {
	const ghDir = join(projectRoot, ".greenhouse");
	await mkdir(ghDir, { recursive: true });
	_logFilePath = join(ghDir, "daemon.log");
}

function log(level: "info" | "warn" | "error" | "debug", msg: string, extra?: object): void {
	const entry = { ts: new Date().toISOString(), level, msg, ...extra };
	const line = `${JSON.stringify(entry)}\n`;
	process.stderr.write(line);
	if (_logFilePath) {
		try {
			appendFileSync(_logFilePath, line);
		} catch {
			// ignore write errors (e.g. disk full) — logging must not crash the daemon
		}
	}
}

/**
 * Perform post-ship cleanup after a supervisor session exits with "shipped" status.
 *
 * Steps:
 * 1. git checkout main (via cleanupAfterShip)
 * 2. git branch -D <mergeBranch> (via cleanupAfterShip)
 * 3. git pull origin main
 *
 * Failures are logged but do not crash the daemon — cleanup is best-effort.
 */
async function _performPostShipCleanup(
	run: RunState,
	config: DaemonConfig,
	exec: ExecFn,
): Promise<void> {
	const repoConfig = config.repos.find((r) => `${r.owner}/${r.repo}` === run.ghRepo);
	if (!repoConfig) {
		log("warn", "Post-ship cleanup: repo config not found", {
			event: "run.cleanup_skipped",
			seedsId: run.seedsId,
			ghRepo: run.ghRepo,
		});
		return;
	}

	const projectRoot = repoConfig.project_root;

	try {
		// Return to main and delete local merge branch
		await cleanupAfterShip(run, repoConfig, exec);

		// Pull latest main so the local repo is up to date
		await exec(["git", "pull", "origin", "main"], { cwd: projectRoot });

		// TODO(v0.2.0): removed in daemon rewrite (spec-file cleanup)

		log("info", "Post-ship cleanup complete", {
			event: "run.cleanup_complete",
			seedsId: run.seedsId,
		});
	} catch (err) {
		log("warn", "Post-ship cleanup failed (non-fatal)", {
			event: "run.cleanup_failed",
			seedsId: run.seedsId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Kill any greenhouse-supervisor-* tmux sessions that are NOT associated with
 * a currently active run. Called once at daemon startup to clear stale sessions
 * left from prior daemon instances.
 */
export async function cleanupStaleSupervisors(
	_config: DaemonConfig,
	_exec: ExecFn = defaultExec,
): Promise<void> {
	// TODO(v0.2.0): removed in daemon rewrite
}

/**
 * Monitor all active supervisor sessions and advance their state when they exit.
 */
async function monitorSupervisors(_config: DaemonConfig, _exec: ExecFn): Promise<void> {
	// TODO(v0.2.0): removed in daemon rewrite
}

/**
 * Run one full poll cycle across all repos.
 */
export async function runPollCycle(
	_config: DaemonConfig,
	_exec: ExecFn = defaultExec,
): Promise<void> {
	// TODO(v0.2.0): removed in daemon rewrite
	await monitorSupervisors(_config, _exec);
}

/**
 * Get a summary of all tracked runs.
 */
export async function getRunsSummary(config: DaemonConfig): Promise<RunState[]> {
	const allRuns: RunState[] = [];
	for (const repo of config.repos) {
		const runs = await readAllRuns(repo.project_root);
		allRuns.push(...runs);
	}
	return allRuns;
}

/**
 * Main daemon loop. Runs until signal received.
 * @param config - Initial daemon configuration.
 * @param configPath - Optional path to config file; used for SIGHUP reload.
 */
export async function runDaemon(config: DaemonConfig, configPath?: string): Promise<void> {
	// Initialize log file before first log() call so all startup messages land there.
	// Use first repo's project_root as cwd heuristic; fall back to cwd if no repos.
	const logRoot = config.repos[0]?.project_root ?? ".";
	await initLogFile(logRoot);

	log("info", "Greenhouse daemon starting", {
		repos: config.repos.map((r) => `${r.owner}/${r.repo}`),
		poll_interval_minutes: config.poll_interval_minutes,
		daily_cap: config.daily_cap,
	});

	// Write PID file so `grhs status` can detect the daemon in foreground mode.
	const pidPath = pidFilePath();
	await mkdir(".greenhouse", { recursive: true });
	await writePid(pidPath, process.pid);

	// Kill any stale greenhouse-supervisor-* tmux sessions from prior daemon instances.
	await cleanupStaleSupervisors(config, defaultExec);

	let running = true;
	let currentConfig = config;

	const shutdown = () => {
		log("info", "Shutdown signal received, finishing current cycle");
		running = false;
	};

	const reloadConfig = () => {
		loadConfig(configPath)
			.then((newConfig) => {
				currentConfig = newConfig;
				log("info", "Config reloaded via SIGHUP");
			})
			.catch((err: unknown) => {
				log("error", "Failed to reload config on SIGHUP", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	process.on("SIGHUP", reloadConfig);

	try {
		while (running) {
			try {
				await runPollCycle(currentConfig, defaultExec);
			} catch (err) {
				log("error", "Poll cycle error", {
					error: err instanceof Error ? err.message : String(err),
				});
			}

			if (!running) break;

			const sleepMs = currentConfig.poll_interval_minutes * 60 * 1000;
			log("info", "Sleeping until next poll", {
				next_poll_in_minutes: currentConfig.poll_interval_minutes,
			});

			// Sleep in small intervals so we can respond to signals promptly
			const intervalMs = 5000;
			let slept = 0;
			while (slept < sleepMs && running) {
				await new Promise((r) => setTimeout(r, Math.min(intervalMs, sleepMs - slept)));
				slept += intervalMs;
			}
		}
	} finally {
		await removePid(pidPath);
	}

	log("info", "Greenhouse daemon stopped");
}
