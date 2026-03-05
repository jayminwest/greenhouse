/**
 * grhs runs — List and manage tracked runs
 * grhs run show <gh-issue-id> — Show detailed run state
 * grhs run retry <gh-issue-id> — Retry a failed run
 * grhs run cancel <gh-issue-id> — Cancel a pending/running run
 */

import type { Command } from "commander";

export function registerRunsCommand(program: Command): void {
	// grhs runs — list all tracked runs
	program
		.command("runs")
		.description("List all tracked runs")
		.option(
			"--status <status>",
			"Filter by status (pending|ingested|running|shipping|shipped|failed)",
		)
		.option("--repo <owner/repo>", "Filter by repo")
		.option("--limit <n>", "Max results", "20")
		.action((opts: { status?: string; repo?: string; limit: string }) => {
			const limit = Number.parseInt(opts.limit, 10);
			process.stdout.write(`Listing runs (limit: ${limit}`);
			if (opts.status) process.stdout.write(`, status: ${opts.status}`);
			if (opts.repo) process.stdout.write(`, repo: ${opts.repo}`);
			process.stdout.write(")...\n");
			// TODO: read .greenhouse/state.jsonl, filter, and display
		});

	// grhs run — subcommand group for individual run operations
	const run = program.command("run").description("Manage individual runs");

	run
		.command("show <gh-issue-id>")
		.description("Show detailed run state for a GitHub issue")
		.action((ghIssueId: string) => {
			process.stdout.write(`Showing run for GitHub issue #${ghIssueId}...\n`);
			// TODO: read .greenhouse/state.jsonl, find entry by ghIssueId, display details
		});

	run
		.command("retry <gh-issue-id>")
		.description("Retry a failed run")
		.action((ghIssueId: string) => {
			process.stdout.write(`Retrying run for GitHub issue #${ghIssueId}...\n`);
			// TODO: read state.jsonl, find failed entry, reset retryable state, re-dispatch
		});

	run
		.command("cancel <gh-issue-id>")
		.description("Cancel a pending or running run")
		.action((ghIssueId: string) => {
			process.stdout.write(`Cancelling run for GitHub issue #${ghIssueId}...\n`);
			// TODO: read state.jsonl, find pending/running entry, mark as failed with reason "cancelled"
		});
}
