import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cleanupStaleSupervisors, initLogFile, runPollCycle } from "./daemon.ts";
import type { DaemonConfig, ExecResult } from "./types.ts";

const TMP = join(import.meta.dir, ".test-daemon-tmp");

function makeConfig(): DaemonConfig {
	return {
		version: "1",
		clone_root: join(TMP, "runs"),
		repos: [
			{
				owner: "testowner",
				repo: "testrepo",
				ready_label: "greenhouse:ready",
			},
		],
		poll_interval_minutes: 10,
		run_timeout_minutes: 90,
	};
}

const noopExec = async (_cmd: string[]): Promise<ExecResult> => ({
	exitCode: 0,
	stdout: "",
	stderr: "",
});

beforeEach(() => {
	mkdirSync(join(TMP, ".greenhouse"), { recursive: true });
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
});

describe("initLogFile", () => {
	test("creates .greenhouse directory and sets log path", async () => {
		await initLogFile(TMP);
		expect(existsSync(join(TMP, ".greenhouse"))).toBe(true);
	});
});

describe("runPollCycle stub", () => {
	test("resolves without throwing", async () => {
		await expect(runPollCycle(makeConfig(), noopExec)).resolves.toBeUndefined();
	});
});

describe("cleanupStaleSupervisors stub", () => {
	test("resolves without throwing", async () => {
		await expect(cleanupStaleSupervisors(makeConfig(), noopExec)).resolves.toBeUndefined();
	});
});
