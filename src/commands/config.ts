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
			process.stdout.write(`poll_interval_minutes: ${config.poll_interval_minutes}\n`);
			process.stdout.write(`daily_cap: ${config.daily_cap}\n`);
			process.stdout.write(`\nrepos:\n`);
			for (const repo of config.repos) {
				process.stdout.write(`  - owner: ${repo.owner}\n`);
				process.stdout.write(`    repo: ${repo.repo}\n`);
				process.stdout.write(`    labels: [${repo.labels.join(", ")}]\n`);
				process.stdout.write(`    project_root: ${repo.project_root}\n`);
			}
			process.stdout.write(`\ndispatch:\n`);
			process.stdout.write(`  capability: ${config.dispatch.capability}\n`);
			process.stdout.write(`  max_concurrent: ${config.dispatch.max_concurrent}\n`);
			process.stdout.write(
				`  monitor_interval_seconds: ${config.dispatch.monitor_interval_seconds}\n`,
			);
			process.stdout.write(`  run_timeout_minutes: ${config.dispatch.run_timeout_minutes}\n`);
			process.stdout.write(`\nshipping:\n`);
			process.stdout.write(`  auto_push: ${config.shipping.auto_push}\n`);
		});
}
