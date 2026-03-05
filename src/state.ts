import { randomBytes } from "node:crypto";
import { closeSync, openSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { RunState } from "./types.ts";
import {
	GREENHOUSE_DIR,
	LOCK_RETRY_MS,
	LOCK_STALE_MS,
	LOCK_TIMEOUT_MS,
	STATE_FILE,
} from "./types.ts";

// ─── Locking ─────────────────────────────────────────────────────────────────

function lockFilePath(dataFilePath: string): string {
	return `${dataFilePath}.lock`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(dataFilePath: string): Promise<void> {
	const lock = lockFilePath(dataFilePath);
	const start = Date.now();
	while (true) {
		try {
			const fd = openSync(lock, "wx");
			closeSync(fd);
			return;
		} catch (err: unknown) {
			const nodeErr = err as NodeJS.ErrnoException;
			if (nodeErr.code !== "EEXIST") throw err;
			try {
				const st = statSync(lock);
				if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
					unlinkSync(lock);
					continue;
				}
			} catch {
				continue;
			}
			if (Date.now() - start > LOCK_TIMEOUT_MS) {
				throw new Error(`Timeout acquiring lock for ${dataFilePath}`);
			}
			await sleep(LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS));
		}
	}
}

function releaseLock(dataFilePath: string): void {
	try {
		unlinkSync(lockFilePath(dataFilePath));
	} catch {
		// best-effort
	}
}

export async function withLock<T>(dataFilePath: string, fn: () => Promise<T>): Promise<T> {
	await acquireLock(dataFilePath);
	try {
		return await fn();
	} finally {
		releaseLock(dataFilePath);
	}
}

// ─── JSONL helpers ───────────────────────────────────────────────────────────

function parseJsonl(content: string): RunState[] {
	const results: RunState[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			results.push(JSON.parse(trimmed) as RunState);
		} catch {
			// skip malformed lines
		}
	}
	return results;
}

/** Last entry per (ghIssueId, ghRepo) pair wins. */
function deduplicateRuns(items: RunState[]): RunState[] {
	const map = new Map<string, RunState>();
	for (const item of items) {
		map.set(`${item.ghRepo}#${item.ghIssueId}`, item);
	}
	return Array.from(map.values());
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function statePath(greeniouseDir?: string): string {
	return join(greeniouseDir ?? GREENHOUSE_DIR, STATE_FILE);
}

export async function readState(greeniouseDir?: string): Promise<RunState[]> {
	const file = Bun.file(statePath(greeniouseDir));
	if (!(await file.exists())) return [];
	const content = await file.text();
	return deduplicateRuns(parseJsonl(content));
}

export async function appendRun(run: RunState, greeniouseDir?: string): Promise<void> {
	const filePath = statePath(greeniouseDir);
	const tmpPath = `${filePath}.tmp.${randomBytes(4).toString("hex")}`;
	const file = Bun.file(filePath);
	const existing = (await file.exists()) ? await file.text() : "";
	await Bun.write(tmpPath, `${existing + JSON.stringify(run)}\n`);
	renameSync(tmpPath, filePath);
}

export async function updateRun(
	ghIssueId: number,
	ghRepo: string,
	updates: Partial<RunState>,
	greeniouseDir?: string,
): Promise<RunState> {
	const filePath = statePath(greeniouseDir);
	return withLock(filePath, async () => {
		const runs = await readState(greeniouseDir);
		const idx = runs.findIndex((r) => r.ghIssueId === ghIssueId && r.ghRepo === ghRepo);
		if (idx === -1) {
			throw new Error(`No run found for ${ghRepo}#${ghIssueId}`);
		}
		const updated: RunState = {
			...runs[idx]!,
			...updates,
			updatedAt: new Date().toISOString(),
		};
		runs[idx] = updated;
		const tmpPath = `${filePath}.tmp.${randomBytes(4).toString("hex")}`;
		const content = `${runs.map((r) => JSON.stringify(r)).join("\n")}\n`;
		await Bun.write(tmpPath, content);
		renameSync(tmpPath, filePath);
		return updated;
	});
}

export async function writeAllRuns(runs: RunState[], greeniouseDir?: string): Promise<void> {
	const filePath = statePath(greeniouseDir);
	const tmpPath = `${filePath}.tmp.${randomBytes(4).toString("hex")}`;
	const content = `${runs.map((r) => JSON.stringify(r)).join("\n")}\n`;
	await Bun.write(tmpPath, content);
	renameSync(tmpPath, filePath);
}
