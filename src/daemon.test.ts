import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runPollCycle } from "./daemon.ts";
import { appendRun, readAllRuns } from "./state.ts";
import type { DaemonConfig, ExecResult, RunState } from "./types.ts";

const TMP = join(import.meta.dir, ".test-daemon-tmp");

function makeConfig(): DaemonConfig {
	return {
		version: "1",
		repos: [
			{
				owner: "testowner",
				repo: "testrepo",
				labels: ["ready"],
				project_root: TMP,
			},
		],
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
			pr_template: "",
		},
	};
}

function makeRun(overrides: Partial<RunState> = {}): RunState {
	return {
		ghIssueId: 42,
		ghRepo: "testowner/testrepo",
		ghTitle: "Test issue",
		ghLabels: ["ready"],
		seedsId: "testrepo-a1b2",
		status: "pending",
		discoveredAt: "2026-03-05T10:00:00Z",
		updatedAt: "2026-03-05T10:00:00Z",
		...overrides,
	};
}

/**
 * Minimal exec mock for runPollCycle tests.
 * Returns stub responses for all commands the cycle might invoke.
 * Pass `overrides` to customize specific commands.
 */
function makeExec(overrides?: (cmd: string[]) => ExecResult | null) {
	return async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
		const custom = overrides?.(cmd);
		if (custom) return custom;
		// Poll: return no open issues
		if (cmd[0] === "gh" && cmd[1] === "issue") {
			return { exitCode: 0, stdout: "[]", stderr: "" };
		}
		// Monitor: return no active agents (coordinator not running)
		if (cmd[0] === "ov" && cmd[1] === "status") {
			return {
				exitCode: 0,
				stdout: JSON.stringify({ success: true, command: "status", currentRunId: "", agents: [] }),
				stderr: "",
			};
		}
		// Seeds show: return open issue (run not yet complete)
		if (cmd[0] === "sd" && cmd[1] === "show") {
			return {
				exitCode: 0,
				stdout: JSON.stringify({
					success: true,
					issue: {
						id: "testrepo-a1b2",
						status: "open",
						title: "Test",
						createdAt: "",
						updatedAt: "",
					},
				}),
				stderr: "",
			};
		}
		return { exitCode: 0, stdout: "", stderr: "" };
	};
}

beforeEach(() => {
	mkdirSync(join(TMP, ".greenhouse"), { recursive: true });
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
});

describe("runPollCycle retry cap", () => {
	test("marks run non-retryable after MAX_RETRY_ATTEMPTS exceeded", async () => {
		const run = makeRun({ status: "failed", retryable: true });
		await appendRun(run, TMP);

		const retryAttempts = new Map<string, number>();
		const config = makeConfig();

		// Exec that fails coordinator commands so dispatch always throws.
		// The run will remain failed+retryable until the cap is reached.
		const exec = makeExec((cmd) => {
			if (cmd[0] === "ov" && cmd[1] === "coordinator") {
				return { exitCode: 1, stdout: "", stderr: "coordinator unavailable" };
			}
			if (cmd[0] === "git") {
				return { exitCode: 1, stdout: "", stderr: "branch creation failed" };
			}
			return null;
		});

		// Call runPollCycle MAX_RETRY_ATTEMPTS+1 times with the same retryAttempts map.
		// After the (MAX+1)th call the cap is exceeded and the run is marked non-retryable.
		for (let i = 0; i < 4; i++) {
			await runPollCycle(config, exec, retryAttempts);
		}

		const runs = await readAllRuns(TMP);
		const result = runs.find((r) => r.seedsId === "testrepo-a1b2");
		expect(result?.retryable).toBe(false);
		expect(result?.status).toBe("failed");
	});

	test("retries run up to MAX_RETRY_ATTEMPTS times before capping", async () => {
		const run = makeRun({ status: "failed", retryable: true });
		await appendRun(run, TMP);

		const retryAttempts = new Map<string, number>();
		const config = makeConfig();
		let dispatchAttempts = 0;

		const exec = makeExec((cmd) => {
			// Count git branch calls as proxy for dispatch attempts
			if (cmd[0] === "git" && cmd[1] === "branch") {
				dispatchAttempts++;
				return { exitCode: 1, stdout: "", stderr: "branch failed" };
			}
			return null;
		});

		// 4 cycles: attempts 1, 2, 3 dispatch; attempt 4 caps
		for (let i = 0; i < 4; i++) {
			await runPollCycle(config, exec, retryAttempts);
		}

		// Dispatch was attempted exactly MAX_RETRY_ATTEMPTS (3) times
		expect(dispatchAttempts).toBe(3);

		// Run is now non-retryable
		const runs = await readAllRuns(TMP);
		expect(runs.find((r) => r.seedsId === "testrepo-a1b2")?.retryable).toBe(false);
	});

	test("fresh retryAttempts map restarts the counter", async () => {
		const run = makeRun({ status: "failed", retryable: true });
		await appendRun(run, TMP);

		const config = makeConfig();
		const exec = makeExec((cmd) => {
			if (cmd[0] === "git") return { exitCode: 1, stdout: "", stderr: "branch failed" };
			return null;
		});

		// Exhaust with one map
		const map1 = new Map<string, number>();
		for (let i = 0; i < 4; i++) {
			await runPollCycle(config, exec, map1);
		}

		// Run is non-retryable
		let runs = await readAllRuns(TMP);
		expect(runs.find((r) => r.seedsId === "testrepo-a1b2")?.retryable).toBe(false);

		// Manually reset the run to retryable (simulates daemon restart)
		await appendRun(makeRun({ status: "failed", retryable: true }), TMP);

		// A fresh map allows retries again
		const map2 = new Map<string, number>();
		let attempts2 = 0;
		const exec2 = makeExec((cmd) => {
			if (cmd[0] === "git" && cmd[1] === "branch") {
				attempts2++;
				return { exitCode: 1, stdout: "", stderr: "branch failed" };
			}
			return null;
		});
		await runPollCycle(config, exec2, map2);
		expect(attempts2).toBe(1);

		// Still retryable after 1 attempt
		runs = await readAllRuns(TMP);
		expect(runs.find((r) => r.seedsId === "testrepo-a1b2")?.retryable).toBe(true);
	});

	test("no-op when there are no failed retryable runs", async () => {
		await appendRun(makeRun({ status: "shipped", shippedAt: new Date().toISOString() }), TMP);

		const retryAttempts = new Map<string, number>();
		const config = makeConfig();
		let dispatchAttempts = 0;

		const exec = makeExec((cmd) => {
			if (cmd[0] === "git" && cmd[1] === "branch") {
				dispatchAttempts++;
				return null;
			}
			return null;
		});

		await runPollCycle(config, exec, retryAttempts);
		expect(dispatchAttempts).toBe(0);
	});
});
