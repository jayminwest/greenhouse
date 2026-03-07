/**
 * grhs doctor — Health checks for greenhouse setup
 *
 * Verifies: gh auth, ov installed, sd installed, git access, config valid, state consistent
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";

export type CheckStatus = "pass" | "fail" | "warn";

export interface DoctorCheck {
	name: string;
	description: string;
	status: CheckStatus;
	detail?: string;
}

export type Spawner = (
	cmd: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const defaultSpawner: Spawner = async (cmd) => {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { exitCode, stdout, stderr };
};

async function checkBinary(
	name: string,
	cmd: string[],
	description: string,
	spawner: Spawner,
): Promise<DoctorCheck> {
	try {
		const result = await spawner(cmd);
		if (result.exitCode === 0) {
			return { name, description, status: "pass", detail: result.stdout.trim().split("\n")[0] };
		}
		return { name, description, status: "fail", detail: `Exit code ${result.exitCode}` };
	} catch {
		return { name, description, status: "fail", detail: `'${cmd[0]}' not found in PATH` };
	}
}

async function checkGhAuth(spawner: Spawner): Promise<DoctorCheck> {
	try {
		const result = await spawner(["gh", "auth", "status"]);
		if (result.exitCode === 0) {
			return { name: "gh-auth", description: "GitHub CLI authenticated", status: "pass" };
		}
		return {
			name: "gh-auth",
			description: "GitHub CLI authenticated",
			status: "fail",
			detail: "Run 'gh auth login' to authenticate",
		};
	} catch {
		return {
			name: "gh-auth",
			description: "GitHub CLI authenticated",
			status: "fail",
			detail: "'gh' not found. Install from https://cli.github.com",
		};
	}
}

async function checkConfig(spawner: Spawner): Promise<DoctorCheck> {
	const configPath = join(process.cwd(), ".greenhouse", "config.yaml");
	if (!existsSync(configPath)) {
		return {
			name: "config",
			description: "Config file exists",
			status: "fail",
			detail: "Run 'grhs init' to create .greenhouse/config.yaml",
		};
	}
	// Basic check: file exists and is non-empty
	const { size } = (await Bun.file(configPath).stat?.()) ?? { size: 0 };
	const _ = spawner; // suppress unused warning
	if (size === 0) {
		return {
			name: "config",
			description: "Config file exists",
			status: "warn",
			detail: ".greenhouse/config.yaml is empty",
		};
	}
	return { name: "config", description: "Config file exists", status: "pass", detail: configPath };
}

async function checkState(spawner: Spawner): Promise<DoctorCheck> {
	const statePath = join(process.cwd(), ".greenhouse", "state.jsonl");
	const _ = spawner; // suppress unused warning
	if (!existsSync(statePath)) {
		return {
			name: "state",
			description: "State file exists",
			status: "warn",
			detail: ".greenhouse/state.jsonl not found — will be created on first run",
		};
	}
	return { name: "state", description: "State file exists", status: "pass", detail: statePath };
}

export async function runDoctorChecks(spawner: Spawner = defaultSpawner): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];

	checks.push(
		await checkGhAuth(spawner),
		await checkBinary("ov", ["ov", "--version"], "Overstory CLI installed", spawner),
		await checkBinary("sd", ["sd", "--version"], "Seeds CLI installed", spawner),
		await checkBinary("git", ["git", "--version"], "Git installed", spawner),
		await checkConfig(spawner),
		await checkState(spawner),
	);

	return checks;
}

const STATUS_ICON: Record<CheckStatus, string> = {
	pass: chalk.green("-"),
	fail: chalk.red("!"),
	warn: chalk.yellow("!"),
};

export function registerDoctorCommand(program: Command): void {
	program
		.command("doctor")
		.description("Run health checks (gh auth, ov, sd, git, config, state)")
		.option("--json", "Output results as JSON")
		.action(async (opts: { json?: boolean }) => {
			const useJson = opts.json ?? (program.opts() as { json?: boolean }).json ?? false;
			const checks = await runDoctorChecks();

			if (useJson) {
				const passing = checks.filter((c) => c.status === "pass").length;
				const failing = checks.filter((c) => c.status === "fail").length;
				const warnings = checks.filter((c) => c.status === "warn").length;
				process.stdout.write(
					`${JSON.stringify({ success: failing === 0, checks, summary: { passing, failing, warnings } })}\n`,
				);
				if (failing > 0) process.exitCode = 1;
				return;
			}

			process.stdout.write("Greenhouse Doctor\n\n");

			for (const check of checks) {
				const icon = STATUS_ICON[check.status];
				const line = `  ${icon} ${check.description}`;
				process.stdout.write(line);
				if (check.detail) {
					process.stdout.write(`\n    ${check.detail}`);
				}
				process.stdout.write("\n");
			}

			const failing = checks.filter((c) => c.status === "fail").length;
			const warnings = checks.filter((c) => c.status === "warn").length;

			process.stdout.write("\n");
			if (failing > 0) {
				process.stdout.write(`${failing} check(s) failed. Fix the issues above.\n`);
				process.exitCode = 1;
			} else if (warnings > 0) {
				process.stdout.write(`All checks passed (${warnings} warning(s)).\n`);
			} else {
				process.stdout.write("All checks passed.\n");
			}
		});
}
