import chalk from "chalk";
import type { DailyBudget, RunState } from "./types.ts";

// === Duration utilities ===

export interface StageDurations {
	ingestMs?: number; // discoveredAt → ingestedAt
	agentMs?: number; // dispatchedAt → completedAt (or now if still running)
	shippingMs?: number; // completedAt → shippedAt
	totalMs?: number; // discoveredAt → shippedAt (or now if active)
	isRunning: boolean;
}

/** Format milliseconds into a human-readable string like "8m 23s" or "1h 2m". */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/** Compute per-stage durations from a RunState's timestamps. */
export function computeStageDurations(run: RunState): StageDurations {
	const now = Date.now();
	const discovered = new Date(run.discoveredAt).getTime();
	const ingested = run.ingestedAt ? new Date(run.ingestedAt).getTime() : undefined;
	const dispatched = run.dispatchedAt ? new Date(run.dispatchedAt).getTime() : undefined;
	const completed = run.completedAt ? new Date(run.completedAt).getTime() : undefined;
	const shipped = run.shippedAt ? new Date(run.shippedAt).getTime() : undefined;

	const isRunning = run.status === "running";

	const ingestMs = ingested !== undefined ? ingested - discovered : undefined;
	const agentMs =
		dispatched !== undefined
			? completed !== undefined
				? completed - dispatched
				: isRunning
					? now - dispatched
					: undefined
			: undefined;
	const shippingMs =
		completed !== undefined && shipped !== undefined ? shipped - completed : undefined;
	const totalMs =
		shipped !== undefined ? shipped - discovered : isRunning ? now - discovered : undefined;

	return { ingestMs, agentMs, shippingMs, totalMs, isRunning };
}

/** Returns a compact duration string for one-line run output. */
export function compactDuration(run: RunState): string {
	const { agentMs, totalMs, isRunning } = computeStageDurations(run);
	if (isRunning && agentMs !== undefined) return `running ${formatDuration(agentMs)}`;
	if (totalMs !== undefined) return formatDuration(totalMs);
	return "";
}

// Greenhouse color palette — earthy/forest tones
export const brand = chalk.rgb(124, 179, 66); // green
export const accent = chalk.rgb(255, 183, 77); // amber
export const muted = chalk.rgb(120, 120, 110); // gray

let _json = false;
let _quiet = false;
let _verbose = false;
let _timing = false;
let _timingStart = 0;

export function setJsonMode(v: boolean): void {
	_json = v;
}

export function isJsonMode(): boolean {
	return _json;
}

export function setQuietMode(v: boolean): void {
	_quiet = v;
}

export function isQuietMode(): boolean {
	return _quiet;
}

export function setVerboseMode(v: boolean): void {
	_verbose = v;
}

export function isVerboseMode(): boolean {
	return _verbose;
}

export function setTimingMode(v: boolean): void {
	_timing = v;
}

export function isTimingMode(): boolean {
	return _timing;
}

export function startTiming(): void {
	_timingStart = Date.now();
}

export function printElapsed(label = "Elapsed"): void {
	if (!_timing) return;
	const ms = Date.now() - _timingStart;
	const s = (ms / 1000).toFixed(3);
	if (_json) {
		process.stderr.write(`${label}: ${s}s\n`);
	} else {
		console.log(`${muted(`${label}:`)} ${s}s`);
	}
}

export function outputJson(data: unknown): void {
	console.log(JSON.stringify(data, null, 2));
}

export function printSuccess(msg: string): void {
	if (_json || _quiet) return;
	console.log(`${brand.bold("✓")} ${brand(msg)}`);
}

export function printError(msg: string): void {
	console.error(`${chalk.red.bold("✗")} ${chalk.red(msg)}`);
}

export function printWarning(msg: string): void {
	if (_json || _quiet) return;
	console.log(`${chalk.yellow.bold("!")} ${chalk.yellow(msg)}`);
}

export function printInfo(msg: string): void {
	if (_json || _quiet) return;
	console.log(`${muted("·")} ${msg}`);
}

export function printDebug(msg: string): void {
	if (!_verbose) return;
	process.stderr.write(`${muted("[debug]")} ${msg}\n`);
}

const STATUS_ICONS: Record<string, string> = {
	pending: chalk.green("-"),
	ingested: chalk.cyan(">"),
	running: chalk.cyan(">"),
	shipping: chalk.cyan(">"),
	shipped: chalk.dim("x"),
	failed: chalk.yellow("!"),
};

export function printRunOneLine(run: RunState): void {
	if (_json || _quiet) return;
	const icon = STATUS_ICONS[run.status] ?? muted("?");
	const repo = muted(run.ghRepo);
	const id = accent.bold(`#${run.ghIssueId}`);
	const title = run.ghTitle.length > 60 ? `${run.ghTitle.slice(0, 57)}...` : run.ghTitle;
	const seedsId = run.seedsId ? muted(` [${run.seedsId}]`) : "";
	const dur = compactDuration(run);
	const durStr = dur ? muted(` ${dur}`) : "";
	console.log(`${icon} ${repo} ${id} ${title}${seedsId}${durStr}`);
}

export function printRunFull(run: RunState): void {
	if (_json || _quiet) return;
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

	const { ingestMs, agentMs, shippingMs, totalMs, isRunning } = computeStageDurations(run);
	const hasDurations = ingestMs !== undefined || agentMs !== undefined || totalMs !== undefined;
	if (hasDurations) {
		console.log("");
		if (ingestMs !== undefined) console.log(`Ingest time: ${muted(formatDuration(ingestMs))}`);
		if (agentMs !== undefined)
			console.log(
				`Agent work:  ${muted(formatDuration(agentMs))}${isRunning ? muted(" (running)") : ""}`,
			);
		if (shippingMs !== undefined) console.log(`Shipping:    ${muted(formatDuration(shippingMs))}`);
		if (totalMs !== undefined) console.log(`Total:       ${accent(formatDuration(totalMs))}`);
	}
}

export function printBudget(budget: DailyBudget): void {
	if (_json || _quiet) return;
	const bar =
		budget.remaining === 0 ? chalk.red("EXHAUSTED") : brand(`${budget.remaining} remaining`);
	console.log(
		`${muted("Budget")} ${muted(budget.date)}  ${accent.bold(String(budget.dispatched))}/${muted(String(budget.cap))} dispatched  ${bar}`,
	);
}
