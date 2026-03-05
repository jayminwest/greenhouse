import chalk from "chalk";
import type { DailyBudget, RunState } from "./types.ts";

// Greenhouse color palette — earthy/forest tones
export const brand = chalk.rgb(124, 179, 66); // green
export const accent = chalk.rgb(255, 183, 77); // amber
export const muted = chalk.rgb(120, 120, 110); // gray

let _json = false;

export function setJsonMode(v: boolean): void {
	_json = v;
}

export function isJsonMode(): boolean {
	return _json;
}

export function outputJson(data: unknown): void {
	console.log(JSON.stringify(data, null, 2));
}

export function printSuccess(msg: string): void {
	if (_json) return;
	console.log(`${brand("✓")} ${brand(msg)}`);
}

export function printError(msg: string): void {
	console.error(`${chalk.red("✗")} ${msg}`);
}

export function printWarning(msg: string): void {
	if (_json) return;
	console.log(`${chalk.yellow("!")} ${msg}`);
}

export function printInfo(msg: string): void {
	if (_json) return;
	console.log(`${muted("·")} ${msg}`);
}

const STATUS_ICONS: Record<string, string> = {
	pending: muted("○"),
	ingested: accent("◎"),
	running: chalk.cyan("◉"),
	shipping: chalk.blue("⬆"),
	shipped: brand("✓"),
	failed: chalk.red("✗"),
};

export function printRunOneLine(run: RunState): void {
	if (_json) return;
	const icon = STATUS_ICONS[run.status] ?? muted("?");
	const repo = muted(run.ghRepo);
	const id = accent.bold(`#${run.ghIssueId}`);
	const title = run.ghTitle.length > 60 ? `${run.ghTitle.slice(0, 57)}...` : run.ghTitle;
	const seedsId = run.seedsId ? muted(` [${run.seedsId}]`) : "";
	console.log(`${icon} ${repo} ${id} ${title}${seedsId}`);
}

export function printRunFull(run: RunState): void {
	if (_json) return;
	const statusColor =
		run.status === "shipped"
			? brand
			: run.status === "failed"
				? chalk.red
				: run.status === "running"
					? chalk.cyan
					: muted;

	console.log(`${accent.bold(`${run.ghRepo}#${run.ghIssueId}`)}  ${statusColor(run.status)}`);
	console.log(`Title:       ${run.ghTitle}`);
	console.log(`Seeds ID:    ${run.seedsId}`);
	if (run.agentName) console.log(`Agent:       ${run.agentName}`);
	if (run.branch) console.log(`Branch:      ${muted(run.branch)}`);
	if (run.prUrl) console.log(`PR:          ${accent(run.prUrl)}`);
	if (run.error) console.log(`Error:       ${chalk.red(run.error)}`);
	console.log(`Discovered:  ${muted(run.discoveredAt)}`);
	if (run.ingestedAt) console.log(`Ingested:    ${muted(run.ingestedAt)}`);
	if (run.dispatchedAt) console.log(`Dispatched:  ${muted(run.dispatchedAt)}`);
	if (run.completedAt) console.log(`Completed:   ${muted(run.completedAt)}`);
	if (run.shippedAt) console.log(`Shipped:     ${muted(run.shippedAt)}`);
	console.log(`Updated:     ${muted(run.updatedAt)}`);
}

export function printBudget(budget: DailyBudget): void {
	if (_json) return;
	const bar =
		budget.remaining === 0 ? chalk.red("EXHAUSTED") : brand(`${budget.remaining} remaining`);
	console.log(
		`${muted("Budget")} ${muted(budget.date)}  ${accent.bold(String(budget.dispatched))}/${muted(String(budget.cap))} dispatched  ${bar}`,
	);
}
