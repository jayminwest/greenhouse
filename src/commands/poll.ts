/**
 * grhs poll — Run one poll cycle (don't start daemon)
 *
 * Useful for testing and one-off runs.
 */

import type { Command } from "commander";
import { loadConfig } from "../config.ts";
import { runPollCycle } from "../daemon.ts";
import { defaultExec } from "../exec.ts";
import { ingestIssue } from "../ingester.ts";
import { pollIssues } from "../poller.ts";
import { appendRun, isIngested } from "../state.ts";
import type { RunState } from "../types.ts";

export function registerPollCommand(program: Command): void {
	program
		.command("poll")
		.description("Run one poll cycle without starting the daemon (useful for testing)")
		.option("--config <path>", "Config file path", ".greenhouse/config.yaml")
		.option("--dry-run", "Poll and report issues found; do not ingest or dispatch")
		.option("--no-dispatch", "Poll and ingest issues; skip dispatch")
		.action(async (opts: { config: string; dryRun?: boolean; dispatch: boolean }) => {
			let config: Awaited<ReturnType<typeof loadConfig>>;
			try {
				config = await loadConfig(opts.config);
			} catch (err) {
				process.stderr.write(
					`Error loading config: ${err instanceof Error ? err.message : String(err)}\n`,
				);
				process.exit(1);
			}

			const exec = defaultExec;

			if (opts.dryRun) {
				// Dry run: poll only, report findings — no state changes
				process.stdout.write("Dry run: polling issues (no ingest or dispatch)\n");
				for (const repo of config.repos) {
					const repoStr = `${repo.owner}/${repo.repo}`;
					try {
						const issues = await pollIssues(repo, exec);
						process.stdout.write(`${repoStr}: ${issues.length} issue(s) found\n`);
						for (const issue of issues) {
							const alreadyIngested = await isIngested(repo.project_root, repoStr, issue.number);
							const marker = alreadyIngested ? "[already ingested]" : "[new]";
							process.stdout.write(`  #${issue.number} ${marker} ${issue.title}\n`);
						}
					} catch (err) {
						process.stderr.write(
							`Poll failed for ${repoStr}: ${err instanceof Error ? err.message : String(err)}\n`,
						);
					}
				}
				return;
			}

			if (!opts.dispatch) {
				// --no-dispatch: poll + ingest, skip dispatch
				process.stdout.write("Polling and ingesting issues (dispatch skipped)\n");
				for (const repo of config.repos) {
					const repoStr = `${repo.owner}/${repo.repo}`;
					try {
						const issues = await pollIssues(repo, exec);
						process.stdout.write(`${repoStr}: ${issues.length} issue(s) found\n`);
						for (const issue of issues) {
							const alreadyIngested = await isIngested(repo.project_root, repoStr, issue.number);
							if (alreadyIngested) {
								process.stdout.write(`  #${issue.number} already ingested, skipping\n`);
								continue;
							}
							const now = new Date().toISOString();
							try {
								const { seedsId } = await ingestIssue(issue, repo, exec);
								const ingestedRun: RunState = {
									ghIssueId: issue.number,
									ghRepo: repoStr,
									ghTitle: issue.title,
									ghLabels: issue.labels.map((l) => l.name),
									seedsId,
									status: "ingested",
									discoveredAt: now,
									ingestedAt: now,
									updatedAt: now,
								};
								await appendRun(ingestedRun, repo.project_root);
								process.stdout.write(`  #${issue.number} ingested as ${seedsId}\n`);
							} catch (err) {
								process.stderr.write(
									`  #${issue.number} ingest failed: ${
										err instanceof Error ? err.message : String(err)
									}\n`,
								);
							}
						}
					} catch (err) {
						process.stderr.write(
							`Poll failed for ${repoStr}: ${err instanceof Error ? err.message : String(err)}\n`,
						);
					}
				}
				return;
			}

			// Default: full poll cycle (poll + ingest + dispatch)
			process.stdout.write(`Running one poll cycle (config: ${opts.config})...\n`);
			try {
				await runPollCycle(config, exec);
				process.stdout.write("Poll cycle complete.\n");
			} catch (err) {
				process.stderr.write(
					`Poll cycle failed: ${err instanceof Error ? err.message : String(err)}\n`,
				);
				process.exit(1);
			}
		});
}
