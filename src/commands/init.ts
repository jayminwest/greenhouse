/**
 * grhs init — Initialize .greenhouse/ in the current directory
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";

const DEFAULT_CONFIG_YAML = (owner: string, repo: string) => `version: "1"

repos:
  - owner: ${owner}
    repo: ${repo}
    labels:
      - agent-ready
    project_root: ${process.cwd()}

poll_interval_minutes: 10
daily_cap: 5

dispatch:
  capability: coordinator
  max_concurrent: 2
  monitor_interval_seconds: 30
  run_timeout_minutes: 90

shipping:
  auto_push: true
  pr_template: |
    ## Greenhouse Auto-PR

    Closes #{github_issue_number}

    **Seeds Task:** {seeds_task_id}

    ### Summary
    {agent_summary}

    ### Quality Gates
    - [ ] Tests pass
    - [ ] Lint clean
    - [ ] Typecheck clean

    ---
    Automated by [Greenhouse](https://github.com/jayminwest/greenhouse)
`;

const GITIGNORE_CONTENT = `daemon.pid
daemon.log
*.lock
`;

export interface InitResult {
	success: boolean;
	created: boolean;
	configPath: string;
	error?: string;
}

export async function initGreenhouseDir(opts: {
	repo?: string;
	json?: boolean;
}): Promise<InitResult> {
	const greenhouseDir = join(process.cwd(), ".greenhouse");
	const configPath = join(greenhouseDir, "config.yaml");

	if (existsSync(configPath)) {
		const result: InitResult = {
			success: false,
			created: false,
			configPath,
			error: ".greenhouse/config.yaml already exists. Use --force to reinitialize.",
		};
		return result;
	}

	// Parse --repo flag
	let owner = "owner";
	let repo = "repo";
	if (opts.repo) {
		const parts = opts.repo.split("/");
		if (parts.length !== 2 || !parts[0] || !parts[1]) {
			return {
				success: false,
				created: false,
				configPath,
				error: `Invalid --repo format: "${opts.repo}". Expected "owner/repo".`,
			};
		}
		owner = parts[0];
		repo = parts[1];
	}

	// Create directory structure
	mkdirSync(greenhouseDir, { recursive: true });
	writeFileSync(configPath, DEFAULT_CONFIG_YAML(owner, repo));
	writeFileSync(join(greenhouseDir, "state.jsonl"), "");
	writeFileSync(join(greenhouseDir, ".gitignore"), GITIGNORE_CONTENT);

	return { success: true, created: true, configPath };
}

export function registerInitCommand(program: Command): void {
	program
		.command("init")
		.description("Initialize .greenhouse/ in current directory")
		.option("--repo <owner/repo>", "Pre-configure a repo (e.g. jayminwest/overstory)")
		.option("--json", "Output result as JSON")
		.action(async (opts: { repo?: string; json?: boolean }) => {
			const useJson = opts.json ?? (program.opts() as { json?: boolean }).json ?? false;
			const result = await initGreenhouseDir(opts);

			if (useJson) {
				process.stdout.write(
					`${JSON.stringify({ success: result.success, created: result.created, configPath: result.configPath, ...(result.error ? { error: result.error } : {}) })}\n`,
				);
				if (!result.success) process.exitCode = 1;
				return;
			}

			if (!result.success) {
				process.stderr.write(`Error: ${result.error}\n`);
				process.exitCode = 1;
				return;
			}

			process.stdout.write("Initialized .greenhouse/\n");
			process.stdout.write(`  config: ${result.configPath}\n`);
			process.stdout.write("  state:  .greenhouse/state.jsonl\n");
			process.stdout.write("\nNext steps:\n");
			process.stdout.write("  1. Edit .greenhouse/config.yaml to add your repos\n");
			process.stdout.write("  2. Run 'grhs doctor' to verify your setup\n");
			process.stdout.write("  3. Run 'grhs start' to begin the daemon\n");
		});
}
