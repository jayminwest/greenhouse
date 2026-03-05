/**
 * grhs config show — Print resolved configuration
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";

const DEFAULT_CONFIG = {
	poll_interval_minutes: 10,
	daily_cap: 5,
	dispatch: {
		capability: "lead",
		max_concurrent: 2,
		monitor_interval_seconds: 30,
		run_timeout_minutes: 60,
	},
	shipping: {
		auto_push: true,
		pr_template:
			"## Greenhouse Auto-PR\n\n**GitHub Issue:** #{github_issue_number}\n**Seeds Task:** {seeds_task_id}\n",
	},
};

export function registerConfigCommand(program: Command): void {
	const configCmd = program.command("config").description("Configuration commands");

	configCmd
		.command("show")
		.description("Print resolved configuration")
		.option("--config <path>", "Config file path", ".greenhouse/config.yaml")
		.option("--json", "Output as JSON")
		.action((opts: { config: string; json?: boolean }) => {
			const useJson = opts.json ?? (program.opts() as { json?: boolean }).json ?? false;
			const configPath = join(process.cwd(), opts.config);

			if (!existsSync(configPath)) {
				if (useJson) {
					process.stdout.write(
						`${JSON.stringify({ success: false, error: `Config not found: ${configPath}` })}\n`,
					);
				} else {
					process.stderr.write(`Config not found: ${configPath}\n`);
					process.stderr.write("Run 'grhs init' to create a config.\n");
				}
				process.exitCode = 1;
				return;
			}

			const raw = readFileSync(configPath, "utf-8");

			if (useJson) {
				// Parse YAML manually using the yaml package at runtime
				// For now emit raw text wrapped in JSON
				process.stdout.write(`${JSON.stringify({ success: true, configPath, raw })}\n`);
				return;
			}

			process.stdout.write(`# Resolved config: ${configPath}\n\n`);
			process.stdout.write(raw);
			process.stdout.write("\n# Defaults applied for missing fields:\n");
			process.stdout.write(`#   poll_interval_minutes: ${DEFAULT_CONFIG.poll_interval_minutes}\n`);
			process.stdout.write(`#   daily_cap: ${DEFAULT_CONFIG.daily_cap}\n`);
			process.stdout.write(
				`#   dispatch.max_concurrent: ${DEFAULT_CONFIG.dispatch.max_concurrent}\n`,
			);
		});
}
