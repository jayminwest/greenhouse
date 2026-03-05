/**
 * grhs ingest <gh-issue-url> — Manually ingest a single GitHub issue
 *
 * Bypasses label filter and daily cap.
 */

import type { Command } from "commander";
import { loadConfig } from "../config.ts";
import { dispatchRun } from "../dispatcher.ts";
import { defaultExec } from "../exec.ts";
import { ingestIssue } from "../ingester.ts";
import { appendRun, updateRun } from "../state.ts";
import type { GhIssue, RepoConfig } from "../types.ts";

/**
 * Parse a GitHub issue URL into owner, repo, and issue number.
 * Accepts: https://github.com/owner/repo/issues/123
 */
export function parseGhIssueUrl(
	url: string,
): { owner: string; repo: string; number: number } | null {
	const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
	if (!match) return null;
	return {
		owner: match[1] as string,
		repo: match[2] as string,
		number: Number.parseInt(match[3] as string, 10),
	};
}

export function registerIngestCommand(program: Command): void {
	program
		.command("ingest <gh-issue-url>")
		.description("Manually ingest a GitHub issue (bypasses label filter and daily cap)")
		.option("--config <path>", "Config file path", ".greenhouse/config.yaml")
		.action(async (ghIssueUrl: string, opts: { config: string }) => {
			const parsed = parseGhIssueUrl(ghIssueUrl);
			if (!parsed) {
				process.stderr.write(
					`Error: invalid GitHub issue URL: ${ghIssueUrl}\nExpected: https://github.com/owner/repo/issues/123\n`,
				);
				process.exit(1);
			}

			const { owner, repo, number } = parsed;
			const ghRepo = `${owner}/${repo}`;

			// Load config to find project_root; fall back to cwd if repo not configured
			let repoConfig: RepoConfig;
			try {
				const config = await loadConfig(opts.config);
				const found = config.repos.find((r) => r.owner === owner && r.repo === repo);
				repoConfig = found ?? { owner, repo, labels: [], project_root: process.cwd() };
			} catch {
				repoConfig = { owner, repo, labels: [], project_root: process.cwd() };
			}

			// Fetch issue via gh
			process.stdout.write(`Fetching ${ghRepo}#${number}...\n`);
			const { exitCode, stdout, stderr } = await defaultExec([
				"gh",
				"issue",
				"view",
				String(number),
				"--repo",
				ghRepo,
				"--json",
				"number,title,body,labels,assignees",
			]);

			if (exitCode !== 0) {
				process.stderr.write(`Error: gh issue view failed: ${stderr.trim()}\n`);
				process.exit(1);
			}

			const issue = JSON.parse(stdout) as GhIssue;
			const now = new Date().toISOString();

			// Write initial run state
			await appendRun(
				{
					ghIssueId: issue.number,
					ghRepo,
					ghTitle: issue.title,
					ghLabels: issue.labels.map((l) => l.name),
					seedsId: "",
					status: "pending",
					discoveredAt: now,
					updatedAt: now,
				},
				repoConfig.project_root,
			);

			// Ingest into seeds
			process.stdout.write("Ingesting issue into seeds...\n");
			const { seedsId } = await ingestIssue(issue, repoConfig);

			await updateRun(
				issue.number,
				ghRepo,
				{ status: "ingested", seedsId, ingestedAt: new Date().toISOString() },
				repoConfig.project_root,
			);

			// Dispatch agent
			process.stdout.write(`Dispatching agent for ${seedsId}...\n`);
			const dispatchResult = await dispatchRun(seedsId, repoConfig);

			await updateRun(
				issue.number,
				ghRepo,
				{
					status: "running",
					seedsId,
					agentName: dispatchResult.agentName,
					branch: dispatchResult.branch,
					dispatchedAt: new Date().toISOString(),
				},
				repoConfig.project_root,
			);

			process.stdout.write(
				`Dispatched: agent=${dispatchResult.agentName} branch=${dispatchResult.branch} seeds=${seedsId}\n`,
			);
		});
}
