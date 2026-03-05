/**
 * grhs ingest <gh-issue-url> — Manually ingest a single GitHub issue
 *
 * Bypasses label filter and daily cap.
 */

import type { Command } from "commander";

export function registerIngestCommand(program: Command): void {
	program
		.command("ingest <gh-issue-url>")
		.description("Manually ingest a GitHub issue (bypasses label filter and daily cap)")
		.option("--config <path>", "Config file path", ".greenhouse/config.yaml")
		.action((ghIssueUrl: string, opts: { config: string }) => {
			process.stdout.write(`Ingesting GitHub issue: ${ghIssueUrl}\n`);
			process.stdout.write(`Config: ${opts.config}\n`);
			// TODO: parse owner/repo/number from URL, fetch issue via gh, create seeds issue,
			//       update state.jsonl, dispatch via ov sling
		});
}
