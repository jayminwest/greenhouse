/**
 * grhs upgrade — Upgrade greenhouse to latest version from npm
 */

import chalk from "chalk";
import type { Command } from "commander";
import { brand, outputJson } from "../output.ts";

const PACKAGE_NAME = "@os-eco/greenhouse-cli";

async function getCurrentVersion(): Promise<string> {
	const pkgPath = new URL("../../package.json", import.meta.url);
	const pkg = JSON.parse(await Bun.file(pkgPath).text()) as { version: string };
	return pkg.version;
}

async function fetchLatestVersion(): Promise<string> {
	const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`);
	if (!res.ok) throw new Error(`Failed to fetch npm registry: ${res.status} ${res.statusText}`);
	const data = (await res.json()) as { version: string };
	return data.version;
}

export function registerUpgradeCommand(program: Command): void {
	program
		.command("upgrade")
		.description("Upgrade greenhouse to the latest version from npm")
		.option("--check", "Check for updates without installing")
		.option("--json", "Output as JSON")
		.action(async (opts: { check?: boolean; json?: boolean }) => {
			const useJson = opts.json ?? (program.opts() as { json?: boolean }).json ?? false;

			let current: string;
			let latest: string;
			try {
				[current, latest] = await Promise.all([getCurrentVersion(), fetchLatestVersion()]);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (useJson) {
					outputJson({ success: false, error: msg });
				} else {
					process.stderr.write(`Error: ${msg}\n`);
				}
				process.exitCode = 1;
				return;
			}

			const upToDate = current === latest;

			if (opts.check) {
				if (useJson) {
					outputJson({ success: true, command: "upgrade", current, latest, upToDate });
				} else if (upToDate) {
					process.stdout.write(`${brand.bold("✓")} Already up to date (${current})\n`);
				} else {
					process.stdout.write(
						`${chalk.yellow.bold("!")} ${chalk.yellow(`Update available: ${current} → ${latest}`)}\n`,
					);
					process.exitCode = 1;
				}
				return;
			}

			if (upToDate) {
				if (useJson) {
					outputJson({
						success: true,
						command: "upgrade",
						current,
						latest,
						upToDate: true,
						updated: false,
					});
				} else {
					process.stdout.write(`${brand.bold("✓")} Already up to date (${current})\n`);
				}
				return;
			}

			if (!useJson) {
				process.stdout.write(`Upgrading ${PACKAGE_NAME} from ${current} to ${latest}...\n`);
			}

			const result = Bun.spawnSync(["bun", "install", "-g", `${PACKAGE_NAME}@latest`], {
				stdout: "inherit",
				stderr: "inherit",
			});

			if (result.exitCode !== 0) {
				const msg = `bun install failed with exit code ${result.exitCode}`;
				if (useJson) {
					outputJson({ success: false, error: msg });
				} else {
					process.stderr.write(`Error: ${msg}\n`);
				}
				process.exitCode = 1;
				return;
			}

			if (useJson) {
				outputJson({
					success: true,
					command: "upgrade",
					current,
					latest,
					upToDate: false,
					updated: true,
				});
			} else {
				process.stdout.write(`${brand.bold("✓")} Upgraded to ${latest}\n`);
			}
		});
}
