import { appendFileSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { BudgetTracker } from "./budget.ts";
import { loadConfig } from "./config.ts";
import { dispatchRun } from "./dispatcher.ts";
import { defaultExec } from "./exec.ts";
import { ingestIssue } from "./ingester.ts";
import { pidFilePath, removePid, writePid } from "./pid.ts";
import { pollIssues } from "./poller.ts";
import { cleanupAfterShip, shipRun } from "./shipper.ts";
import { appendRun, getActiveRuns, isIngested, readAllRuns, updateRun } from "./state.ts";
import {
	isSupervisorAlive,
	killSupervisor,
	spawnSupervisor,
	supervisorSpecPath,
} from "./supervisor.ts";
import type { DaemonConfig, ExecFn, GhIssue, RunState } from "./types.ts";

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
 * 4. Remove spec file (.greenhouse/<seedsId>-spec.md)
 *
 * Failures are logged but do not crash the daemon — cleanup is best-effort.
 */
async function performPostShipCleanup(
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

		// Remove spec file — ignore errors (file may already be gone)
		const specPath = supervisorSpecPath(run.seedsId, projectRoot);
		await unlink(specPath).catch(() => undefined);

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
	config: DaemonConfig,
	exec: ExecFn = defaultExec,
): Promise<void> {
	// List all tmux sessions
	const listResult = await exec(["tmux", "list-sessions", "-F", "#{session_name}"]);
	if (listResult.exitCode !== 0) return; // tmux not running or no sessions

	const allSessions = listResult.stdout
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s.startsWith("greenhouse-supervisor-"));

	if (allSessions.length === 0) return;

	// Collect active run session names across all repos
	const activeSessionNames = new Set<string>();
	for (const repo of config.repos) {
		const activeRuns = await getActiveRuns(repo.project_root);
		for (const run of activeRuns) {
			if (run.supervisorSessionName) {
				activeSessionNames.add(run.supervisorSessionName);
			}
		}
	}

	// Kill sessions not associated with any active run
	for (const session of allSessions) {
		if (activeSessionNames.has(session)) continue;
		try {
			await killSupervisor(session, exec);
			log("info", "Killed stale supervisor session", {
				event: "supervisor.stale_cleanup",
				session,
			});
		} catch (err) {
			log("warn", "Failed to kill stale supervisor session", {
				event: "supervisor.stale_cleanup_failed",
				session,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

/**
 * Monitor all active supervisor sessions and advance their state when they exit.
 * When a supervisor session exits, reads the final state it wrote to state.jsonl.
 */
async function monitorSupervisors(config: DaemonConfig, exec: ExecFn): Promise<void> {
	for (const repo of config.repos) {
		const projectRoot = repo.project_root;
		const repoStr = `${repo.owner}/${repo.repo}`;
		const activeRuns = (await getActiveRuns(projectRoot)).filter((r) => r.ghRepo === repoStr);

		for (const run of activeRuns) {
			if (!run.supervisorSessionName) continue;

			try {
				const alive = await isSupervisorAlive(run.supervisorSessionName, exec);

				if (alive) {
					// Check for daemon-level timeout — hard limit, outer safety net
					const timeoutMs = config.dispatch.run_timeout_minutes * 60 * 1000;
					const spawnedAt = run.supervisorSpawnedAt ?? run.dispatchedAt;
					if (spawnedAt) {
						const elapsedMs = Date.now() - new Date(spawnedAt).getTime();
						if (elapsedMs >= timeoutMs) {
							log("warn", "Supervisor timed out, killing session", {
								event: "supervisor.timeout",
								seedsId: run.seedsId,
								sessionName: run.supervisorSessionName,
								elapsed_minutes: Math.floor(elapsedMs / 60_000),
								timeout_minutes: config.dispatch.run_timeout_minutes,
							});
							await killSupervisor(run.supervisorSessionName, exec);
							await updateRun(
								run.ghIssueId,
								run.ghRepo,
								{
									status: "failed",
									error: `Supervisor timed out after ${config.dispatch.run_timeout_minutes} minutes`,
									retryable: true,
								},
								projectRoot,
							);
						}
					}
					continue;
				}

				// Supervisor exited — read the final state it wrote to state.jsonl
				const allRuns = await readAllRuns(projectRoot);
				const latest = allRuns.filter((r) => r.seedsId === run.seedsId).at(-1);

				if (latest && latest.status === "shipped") {
					log("info", "Supervisor session exited", {
						event: "supervisor.exited",
						seedsId: run.seedsId,
						status: "shipped",
					});
					await performPostShipCleanup(latest, config, exec);
				} else if (latest && latest.status === "failed") {
					log("info", "Supervisor session exited", {
						event: "supervisor.exited",
						seedsId: run.seedsId,
						status: "failed",
					});
				} else {
					// Supervisor exited without writing a terminal state — check whether
					// seeds is closed. If it is, the supervisor completed its work and
					// the daemon should ship. Otherwise, mark as failed.
					log("info", "Supervisor exited without terminal state, checking seeds status", {
						event: "supervisor.exited_check_seeds",
						seedsId: run.seedsId,
					});

					let seedsClosed = false;
					try {
						const seedsResult = await exec(["sd", "show", run.seedsId, "--json"], {
							cwd: projectRoot,
						});
						if (seedsResult.exitCode === 0) {
							const parsed = JSON.parse(seedsResult.stdout) as {
								issue?: { status?: string };
							};
							seedsClosed = parsed.issue?.status === "closed";
						}
					} catch {
						// seeds check failed — fall through to mark failed
					}

					if (seedsClosed && run.mergeBranch) {
						// Seeds closed: supervisor completed work, daemon ships
						const repoConfig = config.repos.find((r) => `${r.owner}/${r.repo}` === run.ghRepo);
						if (repoConfig) {
							try {
								log("info", "Seeds closed, daemon shipping run", {
									event: "run.daemon_shipping",
									seedsId: run.seedsId,
									mergeBranch: run.mergeBranch,
								});
								const { prUrl, prNumber } = await shipRun(run, repoConfig, config, exec);
								await updateRun(
									run.ghIssueId,
									run.ghRepo,
									{
										status: "shipped",
										prUrl,
										prNumber,
										shippedAt: new Date().toISOString(),
									},
									projectRoot,
								);
								await cleanupAfterShip(run, repoConfig, exec).catch(() => undefined);
							} catch (shipErr) {
								log("error", "Daemon shipping failed", {
									event: "run.daemon_ship_failed",
									seedsId: run.seedsId,
									error: shipErr instanceof Error ? shipErr.message : String(shipErr),
								});
								await updateRun(
									run.ghIssueId,
									run.ghRepo,
									{
										status: "failed",
										error: `Daemon shipping failed: ${shipErr instanceof Error ? shipErr.message : String(shipErr)}`,
										retryable: true,
									},
									projectRoot,
								);
							}
						} else {
							log("warn", "Seeds closed but repo config not found, marking failed", {
								event: "supervisor.exited_no_repo",
								seedsId: run.seedsId,
							});
							await updateRun(
								run.ghIssueId,
								run.ghRepo,
								{
									status: "failed",
									error: "Supervisor exited with seeds closed but repo config not found",
									retryable: false,
								},
								projectRoot,
							);
						}
					} else {
						// Seeds not closed: supervisor exited without completing
						log("warn", "Supervisor exited without completing (seeds not closed)", {
							event: "supervisor.exited_no_state",
							seedsId: run.seedsId,
							seeds_closed: seedsClosed,
						});
						await updateRun(
							run.ghIssueId,
							run.ghRepo,
							{
								status: "failed",
								error: "Supervisor exited without completing (seeds not closed)",
								retryable: true,
							},
							projectRoot,
						);
					}
				}
			} catch (err) {
				log("error", "Error monitoring supervisor", {
					seedsId: run.seedsId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// Proactive post-ship cleanup: scan shipped runs for pending local cleanup.
		// The most common scenario is: supervisor writes "shipped" to state.jsonl and
		// exits. Because readAllRuns deduplicates (last entry wins), by the next poll
		// the run is no longer "active" — the loop above never sees it. Use
		// `git branch --list <mergeBranch>` as a proxy for "cleanup not yet run":
		// if the local merge branch still exists, cleanup is needed.
		const allRunsForRepo = await readAllRuns(projectRoot);
		for (const shipped of allRunsForRepo.filter(
			(r) => r.status === "shipped" && r.mergeBranch && r.ghRepo === repoStr,
		)) {
			try {
				const branchCheck = await exec(["git", "branch", "--list", shipped.mergeBranch as string], {
					cwd: projectRoot,
				});
				if (branchCheck.exitCode === 0 && branchCheck.stdout.trim().length > 0) {
					log("info", "Post-ship cleanup pending: local merge branch still exists", {
						event: "run.cleanup_pending",
						seedsId: shipped.seedsId,
						mergeBranch: shipped.mergeBranch,
					});
					await performPostShipCleanup(shipped, config, exec);
				}
			} catch (err) {
				log("error", "Error checking shipped run for cleanup", {
					seedsId: shipped.seedsId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}
}

/**
 * Run one full poll cycle across all repos.
 */
export async function runPollCycle(
	config: DaemonConfig,
	exec: ExecFn = defaultExec,
	budget?: BudgetTracker,
): Promise<void> {
	// 1. Monitor active supervisor sessions
	await monitorSupervisors(config, exec);

	// 2. Count currently active runs across all repos
	let activeCount = 0;
	for (const repo of config.repos) {
		const runs = await getActiveRuns(repo.project_root);
		activeCount += runs.filter((r) => r.ghRepo === `${repo.owner}/${repo.repo}`).length;
	}

	// 3. Dispatch new issues if under max_concurrent
	const tracker = budget ?? new BudgetTracker(config.daily_cap);

	for (const repo of config.repos) {
		if (activeCount >= config.dispatch.max_concurrent) break;
		if (!tracker.hasCapacity()) {
			log("info", "Daily budget exhausted, skipping dispatch");
			break;
		}

		const projectRoot = repo.project_root;
		const repoStr = `${repo.owner}/${repo.repo}`;

		let issues: GhIssue[];
		try {
			issues = await pollIssues(repo, exec);
		} catch (err) {
			log("error", "Poll failed", {
				repo: repoStr,
				error: err instanceof Error ? err.message : String(err),
			});
			continue;
		}

		log("info", "Poll cycle complete", { repo: repoStr, issues_found: issues.length });

		for (const issue of issues) {
			if (activeCount >= config.dispatch.max_concurrent) break;
			if (!tracker.hasCapacity()) break;

			// Skip already-ingested issues
			const alreadyIngested = await isIngested(projectRoot, repoStr, issue.number);
			if (alreadyIngested) continue;

			// Record as discovered
			const nowMs = Date.now();
			const now = new Date(nowMs).toISOString();
			const discoveredRun: RunState = {
				ghIssueId: issue.number,
				ghRepo: repoStr,
				ghTitle: issue.title,
				ghLabels: issue.labels.map((l) => l.name),
				seedsId: "",
				status: "pending",
				discoveredAt: now,
				updatedAt: now,
			};

			try {
				// Ingest: create seeds issue
				const { seedsId } = await ingestIssue(issue, repo, exec);
				discoveredRun.seedsId = seedsId;
				const ingestedRun: RunState = {
					...discoveredRun,
					status: "ingested",
					seedsId,
					ingestedAt: now,
					updatedAt: now,
				};
				await appendRun(ingestedRun, projectRoot);
				log("info", "Issue ingested", {
					event: "run.ingested",
					ghIssueId: issue.number,
					seedsId,
					duration_ms: nowMs - new Date(discoveredRun.discoveredAt).getTime(),
				});

				// Dispatch: send to coordinator with greenhouse merge branch
				const { agentName, mergeBranch, mailId } = await dispatchRun(seedsId, repo, exec, {
					context: {
						seedsTitle: issue.title,
						ghIssueNumber: issue.number,
						ghRepo: repoStr,
						ghIssueBody: issue.body,
						ghLabels: issue.labels.map((l) => l.name),
					},
				});

				// Spawn supervisor to take ownership of the run through completion
				const { sessionName } = await spawnSupervisor({ seedsId, mergeBranch, repo, config }, exec);

				const runningRun: RunState = {
					...ingestedRun,
					status: "running",
					agentName,
					mergeBranch,
					supervisorSessionName: sessionName,
					supervisorSpawnedAt: now,
					dispatchedAt: now,
					updatedAt: now,
				};
				await appendRun(runningRun, projectRoot);
				log("info", "Run dispatched", {
					event: "run.dispatched",
					seedsId,
					agentName,
					mergeBranch,
					mailId,
					supervisorSession: sessionName,
					duration_ms:
						nowMs - new Date(ingestedRun.ingestedAt ?? ingestedRun.discoveredAt).getTime(),
				});

				tracker.consume();
				activeCount++;
			} catch (err) {
				log("error", "Dispatch failed", {
					event: "run.failed",
					ghIssueId: issue.number,
					error: err instanceof Error ? err.message : String(err),
				});
				const failedRun: RunState = {
					...discoveredRun,
					status: "failed",
					error: err instanceof Error ? err.message : String(err),
					retryable: false,
					updatedAt: now,
				};
				await appendRun(failedRun, projectRoot);
			}
		}
	}
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

	const budget = new BudgetTracker(currentConfig.daily_cap);

	try {
		while (running) {
			try {
				await runPollCycle(currentConfig, defaultExec, budget);
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
