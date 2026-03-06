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
 * Returns stub responses for common commands.
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
		// Supervisor alive check (tmux has-session)
		if (cmd[0] === "tmux" && cmd[1] === "has-session") {
			return { exitCode: 0, stdout: "", stderr: "" };
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

describe("monitorSupervisors via runPollCycle", () => {
	test("supervisor still alive: no state change", async () => {
		const run = makeRun({
			status: "running",
			supervisorSessionName: "greenhouse-supervisor-testrepo-a1b2",
		});
		await appendRun(run, TMP);

		const config = makeConfig();
		// tmux has-session returns 0 → supervisor alive
		const exec = makeExec((cmd) => {
			if (cmd[0] === "tmux" && cmd[1] === "has-session") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return null;
		});

		await runPollCycle(config, exec);

		const runs = await readAllRuns(TMP);
		const result = runs.find((r) => r.seedsId === "testrepo-a1b2");
		// Status unchanged — supervisor is still running
		expect(result?.status).toBe("running");
	});

	test("supervisor dead with shipped state: no additional state change", async () => {
		const run = makeRun({
			status: "running",
			supervisorSessionName: "greenhouse-supervisor-testrepo-a1b2",
		});
		await appendRun(run, TMP);

		// Supervisor already wrote shipped state
		await appendRun(makeRun({ status: "shipped", shippedAt: new Date().toISOString() }), TMP);

		const config = makeConfig();
		// tmux has-session returns 1 → supervisor dead
		const exec = makeExec((cmd) => {
			if (cmd[0] === "tmux" && cmd[1] === "has-session") {
				return { exitCode: 1, stdout: "", stderr: "can't find session" };
			}
			return null;
		});

		await runPollCycle(config, exec);

		const runs = await readAllRuns(TMP);
		const latest = runs.filter((r) => r.seedsId === "testrepo-a1b2").at(-1);
		// Latest state is shipped — no extra failed entry appended
		expect(latest?.status).toBe("shipped");
	});

	test("supervisor dead without state update: marks run as failed", async () => {
		const run = makeRun({
			status: "running",
			supervisorSessionName: "greenhouse-supervisor-testrepo-a1b2",
		});
		await appendRun(run, TMP);

		const config = makeConfig();
		// tmux has-session returns 1 → supervisor dead
		const exec = makeExec((cmd) => {
			if (cmd[0] === "tmux" && cmd[1] === "has-session") {
				return { exitCode: 1, stdout: "", stderr: "can't find session" };
			}
			return null;
		});

		await runPollCycle(config, exec);

		const runs = await readAllRuns(TMP);
		const latest = runs.filter((r) => r.seedsId === "testrepo-a1b2").at(-1);
		expect(latest?.status).toBe("failed");
		expect(latest?.retryable).toBe(false);
		expect(latest?.error).toMatch(/supervisor exited without updating state/i);
	});

	test("run without supervisorSessionName is skipped", async () => {
		// Old-style run with no supervisorSessionName (should not cause errors)
		const run = makeRun({ status: "running" });
		await appendRun(run, TMP);

		const config = makeConfig();
		let tmuxCalled = false;
		const exec = makeExec((cmd) => {
			if (cmd[0] === "tmux" && cmd[1] === "has-session") {
				tmuxCalled = true;
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return null;
		});

		await runPollCycle(config, exec);

		// tmux should not have been called for runs without supervisorSessionName
		expect(tmuxCalled).toBe(false);

		const runs = await readAllRuns(TMP);
		const result = runs.find((r) => r.seedsId === "testrepo-a1b2");
		expect(result?.status).toBe("running");
	});
});

describe("runPollCycle dispatch + supervisor spawn", () => {
	test("dispatches new issue and spawns supervisor, stores supervisorSessionName", async () => {
		const config = makeConfig();

		const exec = makeExec((cmd) => {
			// Poll: return one open issue
			if (cmd[0] === "gh" && cmd[1] === "issue") {
				return {
					exitCode: 0,
					stdout: JSON.stringify([
						{
							number: 1,
							title: "Test Issue",
							body: "body",
							labels: [{ name: "ready" }],
							assignees: [],
						},
					]),
					stderr: "",
				};
			}
			// sd create: return seeds ID
			if (cmd[0] === "sd" && cmd[1] === "create") {
				return {
					exitCode: 0,
					stdout: JSON.stringify({ success: true, command: "create", id: "testrepo-c3d4" }),
					stderr: "",
				};
			}
			// git branch (create merge branch)
			if (cmd[0] === "git" && cmd[1] === "branch") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			// ov coordinator status (checked before start)
			if (cmd[0] === "ov" && cmd[1] === "coordinator" && cmd[2] === "status") {
				return {
					exitCode: 0,
					stdout: JSON.stringify({
						success: true,
						command: "status",
						running: false,
						watchdogRunning: false,
						monitorRunning: false,
					}),
					stderr: "",
				};
			}
			// ov coordinator start
			if (cmd[0] === "ov" && cmd[1] === "coordinator" && cmd[2] === "start") {
				return {
					exitCode: 0,
					stdout: JSON.stringify({
						success: true,
						command: "start",
						agentName: "coordinator-abc",
						capability: "coordinator",
						tmuxSession: "ov-coordinator",
						projectRoot: TMP,
						pid: 1234,
						watchdog: true,
						monitor: true,
					}),
					stderr: "",
				};
			}
			// ov coordinator send (dispatch mail)
			if (cmd[0] === "ov" && cmd[1] === "coordinator" && cmd[2] === "send") {
				return {
					exitCode: 0,
					stdout: JSON.stringify({
						success: true,
						command: "send",
						id: "mail-xyz",
						nudged: true,
					}),
					stderr: "",
				};
			}
			// tmux new-session (spawnSupervisor)
			if (cmd[0] === "tmux" && cmd[1] === "new-session") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			// tmux list-panes (get PID)
			if (cmd[0] === "tmux" && cmd[1] === "list-panes") {
				return { exitCode: 0, stdout: "9999\n", stderr: "" };
			}
			// tmux capture-pane (waitForSupervisorReady)
			if (cmd[0] === "tmux" && cmd[1] === "capture-pane") {
				return {
					exitCode: 0,
					stdout: '❯ Try "help"\nbypass permissions',
					stderr: "",
				};
			}
			// tmux send-keys (beacon)
			if (cmd[0] === "tmux" && cmd[1] === "send-keys") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			// tmux has-session (monitoring — no active runs at start)
			if (cmd[0] === "tmux" && cmd[1] === "has-session") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return null;
		});

		await runPollCycle(config, exec);

		const runs = await readAllRuns(TMP);
		const result = runs.find((r) => r.seedsId === "testrepo-c3d4");
		expect(result).toBeDefined();
		expect(result?.status).toBe("running");
		expect(result?.supervisorSessionName).toBe("greenhouse-supervisor-testrepo-c3d4");
	});

	test("no-op when there are no issues to dispatch", async () => {
		const config = makeConfig();
		let dispatchCalled = false;

		const exec = makeExec((cmd) => {
			if (cmd[0] === "ov" && cmd[1] === "coordinator") {
				dispatchCalled = true;
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return null;
		});

		await runPollCycle(config, exec);

		expect(dispatchCalled).toBe(false);
		const runs = await readAllRuns(TMP);
		expect(runs).toHaveLength(0);
	});

	test("skips already-ingested issues", async () => {
		// Pre-populate with an ingested run for issue #42
		await appendRun(
			makeRun({ status: "running", supervisorSessionName: "greenhouse-supervisor-testrepo-a1b2" }),
			TMP,
		);

		const config = makeConfig();
		let dispatchCalled = false;

		const exec = makeExec((cmd) => {
			if (cmd[0] === "gh" && cmd[1] === "issue") {
				return {
					exitCode: 0,
					stdout: JSON.stringify([
						{
							number: 42,
							title: "Test issue",
							body: "",
							labels: [{ name: "ready" }],
							assignees: [],
						},
					]),
					stderr: "",
				};
			}
			if (cmd[0] === "ov" && cmd[1] === "coordinator") {
				dispatchCalled = true;
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			// Supervisor alive
			if (cmd[0] === "tmux" && cmd[1] === "has-session") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return null;
		});

		await runPollCycle(config, exec);

		expect(dispatchCalled).toBe(false);
	});

	test("marks run failed when supervisor spawn fails", async () => {
		const config = makeConfig();

		const exec = makeExec((cmd) => {
			if (cmd[0] === "gh" && cmd[1] === "issue") {
				return {
					exitCode: 0,
					stdout: JSON.stringify([
						{
							number: 5,
							title: "Failing Issue",
							body: "",
							labels: [{ name: "ready" }],
							assignees: [],
						},
					]),
					stderr: "",
				};
			}
			if (cmd[0] === "sd" && cmd[1] === "create") {
				return {
					exitCode: 0,
					stdout: JSON.stringify({ success: true, command: "create", id: "testrepo-e5f6" }),
					stderr: "",
				};
			}
			if (cmd[0] === "git" && cmd[1] === "branch") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (cmd[0] === "ov" && cmd[1] === "coordinator" && cmd[2] === "status") {
				return {
					exitCode: 0,
					stdout: JSON.stringify({
						success: true,
						command: "status",
						running: false,
						watchdogRunning: false,
						monitorRunning: false,
					}),
					stderr: "",
				};
			}
			if (cmd[0] === "ov" && cmd[1] === "coordinator" && cmd[2] === "start") {
				return {
					exitCode: 0,
					stdout: JSON.stringify({
						success: true,
						command: "start",
						agentName: "coordinator-abc",
						capability: "coordinator",
						tmuxSession: "ov-coordinator",
						projectRoot: TMP,
						pid: 1234,
						watchdog: true,
						monitor: true,
					}),
					stderr: "",
				};
			}
			if (cmd[0] === "ov" && cmd[1] === "coordinator" && cmd[2] === "send") {
				return {
					exitCode: 0,
					stdout: JSON.stringify({ success: true, command: "send", id: "mail-xyz", nudged: true }),
					stderr: "",
				};
			}
			// tmux new-session fails
			if (cmd[0] === "tmux" && cmd[1] === "new-session") {
				return { exitCode: 1, stdout: "", stderr: "session already exists" };
			}
			return null;
		});

		await runPollCycle(config, exec);

		const runs = await readAllRuns(TMP);
		const failed = runs.find((r) => r.status === "failed");
		expect(failed).toBeDefined();
	});
});
