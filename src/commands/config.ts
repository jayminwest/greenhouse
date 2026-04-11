/**
 * grhs config show — Print resolved configuration
 */

import { join } from "node:path";
import type { Command } from "commander";
import { loadConfig } from "../config.ts";
import { outputJson, printError } from "../output.ts";
import type { DaemonConfig } from "../types.ts";

export function registerConfigCommand(program: Command): void {
	const configCmd = program.command("config").description("Configuration commands");

	configCmd
		.command("show")
		.description("Print resolved configuration")
		.option("--config <path>", "Config file path", ".greenhouse/config.yaml")
		.option("--json", "Output as JSON")
		.action(async (opts: { config: string; json?: boolean }) => {
			const useJson = opts.json ?? (program.opts() as { json?: boolean }).json ?? false;
			const configPath = join(process.cwd(), opts.config);

			let config: DaemonConfig;
			try {
				config = await loadConfig(configPath);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (useJson) {
					outputJson({ success: false, error: msg });
				} else {
					printError(msg);
				}
				process.exitCode = 1;
				return;
			}

			if (useJson) {
				outputJson({ success: true, configPath, config });
				return;
			}

			process.stdout.write(`# Resolved config: ${configPath}\n\n`);
			process.stdout.write(`version: ${config.version}\n`);
			process.stdout.write(`clone_root: ${config.clone_root}\n`);
			process.stdout.write(`poll_interval_minutes: ${config.poll_interval_minutes}\n`);
			process.stdout.write(`run_timeout_minutes: ${config.run_timeout_minutes}\n`);
			process.stdout.write(`\nrepos:\n`);
			for (const repo of config.repos) {
				process.stdout.write(`  - owner: ${repo.owner}\n`);
				process.stdout.write(`    repo: ${repo.repo}\n`);
				process.stdout.write(`    ready_label: ${repo.ready_label}\n`);
				if (repo.failed_label) process.stdout.write(`    failed_label: ${repo.failed_label}\n`);
				if (repo.clone_url) process.stdout.write(`    clone_url: ${repo.clone_url}\n`);
				if (repo.base_branch) process.stdout.write(`    base_branch: ${repo.base_branch}\n`);
			}
		});
}
