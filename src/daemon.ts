import { BudgetTracker } from "./budget.ts";
import { dispatchRun } from "./dispatcher.ts";
import { defaultExec } from "./exec.ts";
import { ingestIssue } from "./ingester.ts";
import { checkRunStatus } from "./monitor.ts";
import { pollIssues } from "./poller.ts";
import { shipRun } from "./shipper.ts";
import { appendRun, getActiveRuns, isIngested, readAllRuns, updateRun } from "./state.ts";
import type { DaemonConfig, ExecFn, GhIssue, RepoConfig, RunState } from "./types.ts";

function log(level: "info" | "warn" | "error" | "debug", msg: string, extra?: object): void {
	const entry = { ts: new Date().toISOString(), level, msg, ...extra };
	process.stderr.write(`${JSON.stringify(entry)}\n`);
}

/**
 * Monitor all active runs and advance their state.
 * Returns updated runs.
 */
async function monitorActiveRuns(config: DaemonConfig, exec: ExecFn): Promise<void> {
	// Group active runs by repo
	for (const repo of config.repos) {
		const projectRoot = repo.project_root;
		const activeRuns = (await getActiveRuns(projectRoot)).filter(
			(r) => r.ghRepo === `${repo.owner}/${repo.repo}`,
		);

		for (const run of activeRuns) {
			try {
				if (run.status === "running") {
					// Check for timeout
					const dispatchedAt = run.dispatchedAt ? new Date(run.dispatchedAt).getTime() : 0;
					const timeoutMs = config.dispatch.run_timeout_minutes * 60 * 1000;
					if (Date.now() - dispatchedAt > timeoutMs) {
						log("warn", "Run timeout exceeded", {
							seedsId: run.seedsId,
							ghIssueId: run.ghIssueId,
						});
						await updateRun(projectRoot, run, {
							status: "failed",
							error: "run timeout exceeded",
							retryable: true,
						});
						continue;
					}

					// Check completion
					const { completed, state } = await checkRunStatus(run.seedsId, repo, exec);
					log("debug", "Run status", { seedsId: run.seedsId, state });

					if (completed) {
						const updated = await updateRun(projectRoot, run, {
							status: "shipping",
							completedAt: new Date().toISOString(),
						});
						await advanceShipping(updated, repo, config, projectRoot, exec);
					}
				} else if (run.status === "shipping") {
					// Retry shipping if it was interrupted
					await advanceShipping(run, repo, config, projectRoot, exec);
				}
			} catch (err) {
				log("error", "Error monitoring run", {
					seedsId: run.seedsId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}
}

async function advanceShipping(
	run: RunState,
	repo: RepoConfig,
	config: DaemonConfig,
	projectRoot: string,
	exec: ExecFn,
): Promise<void> {
	try {
		const { prUrl, prNumber } = await shipRun(run, repo, config, exec);
		await updateRun(projectRoot, run, {
			status: "shipped",
			prUrl,
			prNumber,
			shippedAt: new Date().toISOString(),
		});
		log("info", "Run shipped", { seedsId: run.seedsId, prUrl });
	} catch (err) {
		log("error", "Shipping failed", {
			seedsId: run.seedsId,
			error: err instanceof Error ? err.message : String(err),
		});
		await updateRun(projectRoot, run, {
			status: "failed",
			error: err instanceof Error ? err.message : String(err),
			retryable: true,
		});
	}
}

/**
 * Run one full poll cycle across all repos.
 */
export async function runPollCycle(
	config: DaemonConfig,
	exec: ExecFn = defaultExec,
): Promise<void> {
	// 1. Monitor active runs first
	await monitorActiveRuns(config, exec);

	// 2. Count currently active runs across all repos
	let activeCount = 0;
	for (const repo of config.repos) {
		const runs = await getActiveRuns(repo.project_root);
		activeCount += runs.filter((r) => r.ghRepo === `${repo.owner}/${repo.repo}`).length;
	}

	// 3. Dispatch new issues if under max_concurrent
	const budget = new BudgetTracker(config.daily_cap);

	for (const repo of config.repos) {
		if (activeCount >= config.dispatch.max_concurrent) break;
		if (!budget.hasCapacity()) {
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
			if (!budget.hasCapacity()) break;

			// Skip already-ingested issues
			const alreadyIngested = await isIngested(projectRoot, repoStr, issue.number);
			if (alreadyIngested) continue;

			// Record as discovered
			const now = new Date().toISOString();
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
				await appendRun(projectRoot, ingestedRun);
				log("info", "Issue ingested", { ghIssueId: issue.number, seedsId });

				// Dispatch: ov sling
				const { agentName, branch, taskId } = await dispatchRun(seedsId, repo, exec);
				const runningRun: RunState = {
					...ingestedRun,
					status: "running",
					agentName,
					branch,
					dispatchedAt: now,
					updatedAt: now,
				};
				await appendRun(projectRoot, runningRun);
				log("info", "Run dispatched", { seedsId: taskId, agentName, branch });

				budget.consume();
				activeCount++;
			} catch (err) {
				log("error", "Dispatch failed", {
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
				await appendRun(projectRoot, failedRun);
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
 */
export async function runDaemon(config: DaemonConfig): Promise<void> {
	log("info", "Greenhouse daemon starting", {
		repos: config.repos.map((r) => `${r.owner}/${r.repo}`),
		poll_interval_minutes: config.poll_interval_minutes,
		daily_cap: config.daily_cap,
	});

	let running = true;

	const shutdown = () => {
		log("info", "Shutdown signal received, finishing current cycle");
		running = false;
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	while (running) {
		try {
			await runPollCycle(config);
		} catch (err) {
			log("error", "Poll cycle error", {
				error: err instanceof Error ? err.message : String(err),
			});
		}

		if (!running) break;

		const sleepMs = config.poll_interval_minutes * 60 * 1000;
		log("info", "Sleeping until next poll", {
			next_poll_in_minutes: config.poll_interval_minutes,
		});

		// Sleep in small intervals so we can respond to signals promptly
		const intervalMs = 5000;
		let slept = 0;
		while (slept < sleepMs && running) {
			await new Promise((r) => setTimeout(r, Math.min(intervalMs, sleepMs - slept)));
			slept += intervalMs;
		}
	}

	log("info", "Greenhouse daemon stopped");
}
