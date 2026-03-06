/**
 * PID file management for the greenhouse daemon.
 */

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { GREENHOUSE_DIR } from "./types.ts";

export function pidFilePath(projectRoot?: string): string {
	return join(projectRoot ?? ".", GREENHOUSE_DIR, "daemon.pid");
}

export async function writePid(pidPath: string, pid: number): Promise<void> {
	await Bun.write(pidPath, `${pid}\n`);
}

export async function readPid(pidPath: string): Promise<number | null> {
	const file = Bun.file(pidPath);
	if (!(await file.exists())) return null;
	const content = (await file.text()).trim();
	const pid = Number.parseInt(content, 10);
	return Number.isNaN(pid) ? null : pid;
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function removePid(pidPath: string): Promise<void> {
	try {
		await unlink(pidPath);
	} catch {
		// Ignore if already removed
	}
}
