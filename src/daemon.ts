import { mkdir } from "node:fs/promises";
import { BudgetTracker } from "./budget.ts";
import { loadConfig } from "./config.ts";
import { dispatchRun } from "./dispatcher.ts";
import { defaultExec } from "./exec.ts";
import { ingestIssue } from "./ingester.ts";
import { pidFilePath, removePid, writePid } from "./pid.ts";
import { pollIssues } from "./poller.ts";
import { appendRun, getActiveRuns, isIngested, readAllRuns, updateRun } from "./state.ts";
import { isSupervisorAlive, killSupervisor, spawnSupervisor } from "./supervisor.ts";
import type { DaemonConfig, ExecFn, GhIssue, RunState } from "./types.ts";

function log(level: "info" | "warn" | "error" | "debug", msg: string, extra?: object): void {
	const entry = { ts: new Date().toISOString(), level, msg, ...extra };
	process.stderr.write(`${JSON.stringify(entry)}\n`);
}

/**
 * Monitor all active supervisor sessions and advance their state when they exit.
 * When a supervisor session exits, reads the final state it wrote to state.jsonl.
 */
async function monitorSupervisors(config: DaemonConfig, exec: ExecFn): Promise<void> {
	for (const repo of config.repos) {
		const projectRoot = repo.project_root;
		const activeRuns = (await getActiveRuns(projectRoot)).filter(
			(r) => r.ghRepo === `${repo.owner}/${repo.repo}`,
		);

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

				if (latest && (latest.status === "shipped" || latest.status === "failed")) {
					log("info", "Supervisor session exited", {
						event: "supervisor.exited",
						seedsId: run.seedsId,
						status: latest.status,
					});
				} else {
					// Supervisor exited without updating state — mark as failed
					log("warn", "Supervisor exited without updating state", {
						event: "supervisor.exited_no_state",
						seedsId: run.seedsId,
					});
					await updateRun(
						run.ghIssueId,
						run.ghRepo,
						{
							status: "failed",
							error: "Supervisor exited without updating state",
							retryable: false,
						},
						projectRoot,
					);
				}
			} catch (err) {
				log("error", "Error monitoring supervisor", {
					seedsId: run.seedsId,
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
	log("info", "Greenhouse daemon starting", {
		repos: config.repos.map((r) => `${r.owner}/${r.repo}`),
		poll_interval_minutes: config.poll_interval_minutes,
		daily_cap: config.daily_cap,
	});

	// Write PID file so `grhs status` can detect the daemon in foreground mode.
	const pidPath = pidFilePath();
	await mkdir(".greenhouse", { recursive: true });
	await writePid(pidPath, process.pid);

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
