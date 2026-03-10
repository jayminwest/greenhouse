import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cleanupStaleSupervisors, initLogFile, runPollCycle } from "./daemon.ts";
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
		// This test covers the race-window path: getActiveRuns sees "running",
		// then supervisor writes "shipped" and dies, then isSupervisorAlive is false.
		// In this test the shipped entry is the deduped state so getActiveRuns returns nothing,
		// but the proactive cleanup scan checks git branch --list.
		// The default mock returns empty for git branch --list → no cleanup triggered.
		const run = makeRun({
			status: "running",
			supervisorSessionName: "greenhouse-supervisor-testrepo-a1b2",
			mergeBranch: "greenhouse/testrepo-a1b2",
		});
		await appendRun(run, TMP);

		// Supervisor already wrote shipped state
		await appendRun(
			makeRun({
				status: "shipped",
				shippedAt: new Date().toISOString(),
				mergeBranch: "greenhouse/testrepo-a1b2",
			}),
			TMP,
		);

		const config = makeConfig();
		// tmux has-session returns 1 → supervisor dead
		const exec = makeExec((cmd) => {
			if (cmd[0] === "tmux" && cmd[1] === "has-session") {
				return { exitCode: 1, stdout: "", stderr: "can't find session" };
			}
			// git branch --list returns empty → no local branch → no cleanup
			if (cmd[0] === "git" && cmd[1] === "branch" && cmd[2] === "--list") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return null;
		});

		await runPollCycle(config, exec);

		const runs = await readAllRuns(TMP);
		const latest = runs.filter((r) => r.seedsId === "testrepo-a1b2").at(-1);
		// Latest state is shipped — no extra failed entry appended
		expect(latest?.status).toBe("shipped");
	});

	test("supervisor dead without state update and seeds open: marks run failed with retryable:true", async () => {
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
			// git branch --list → no branch
			if (cmd[0] === "git" && cmd[1] === "branch" && cmd[2] === "--list") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			// sd show → in_progress (not closed)
			if (cmd[0] === "sd" && cmd[1] === "show") {
				return {
					exitCode: 0,
					stdout: JSON.stringify({
						success: true,
						command: "show",
						issue: { id: "testrepo-a1b2", status: "in_progress" },
					}),
					stderr: "",
				};
			}
			return null;
		});

		await runPollCycle(config, exec);

		const runs = await readAllRuns(TMP);
		const latest = runs.filter((r) => r.seedsId === "testrepo-a1b2").at(-1);
		expect(latest?.status).toBe("failed");
		expect(latest?.retryable).toBe(true);
		expect(latest?.error).toMatch(/seeds not closed/i);
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

describe("post-ship cleanup", () => {
	test("shipped run with local merge branch triggers cleanup (git checkout main, branch delete, pull)", async () => {
		// Simulate the common post-ship scenario: supervisor wrote "shipped" to state.jsonl
		// and exited. By the next poll cycle, the run is no longer in activeRuns (deduped).
		// The proactive scan detects the local merge branch still exists and runs cleanup.
		await appendRun(
			makeRun({
				status: "shipped",
				shippedAt: new Date().toISOString(),
				mergeBranch: "greenhouse/testrepo-a1b2",
			}),
			TMP,
		);

		const config = makeConfig();
		const cleanupCmds: string[][] = [];

		const exec = makeExec((cmd) => {
			// git branch --list returns the branch name → cleanup needed
			if (cmd[0] === "git" && cmd[1] === "branch" && cmd[2] === "--list") {
				return { exitCode: 0, stdout: "  greenhouse/testrepo-a1b2\n", stderr: "" };
			}
			// Track all git commands
			if (cmd[0] === "git") {
				cleanupCmds.push(cmd);
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return null;
		});

		await runPollCycle(config, exec);

		// Verify cleanup sequence: checkout main, delete branch, pull origin main
		const checkoutCmd = cleanupCmds.find((c) => c[1] === "checkout" && c[2] === "main");
		expect(checkoutCmd).toBeDefined();

		const deleteBranchCmd = cleanupCmds.find(
			(c) => c[1] === "branch" && c[2] === "-D" && c[3] === "greenhouse/testrepo-a1b2",
		);
		expect(deleteBranchCmd).toBeDefined();

		const pullCmd = cleanupCmds.find(
			(c) => c[1] === "pull" && c[2] === "origin" && c[3] === "main",
		);
		expect(pullCmd).toBeDefined();
	});

	test("shipped run without local merge branch: no cleanup triggered", async () => {
		await appendRun(
			makeRun({
				status: "shipped",
				shippedAt: new Date().toISOString(),
				mergeBranch: "greenhouse/testrepo-a1b2",
			}),
			TMP,
		);

		const config = makeConfig();
		let checkoutCalled = false;

		const exec = makeExec((cmd) => {
			// git branch --list returns empty → branch already gone
			if (cmd[0] === "git" && cmd[1] === "branch" && cmd[2] === "--list") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (cmd[0] === "git" && cmd[1] === "checkout") {
				checkoutCalled = true;
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return null;
		});

		await runPollCycle(config, exec);

		expect(checkoutCalled).toBe(false);
	});

	test("cleanup failure is non-fatal: poll cycle continues", async () => {
		await appendRun(
			makeRun({
				status: "shipped",
				shippedAt: new Date().toISOString(),
				mergeBranch: "greenhouse/testrepo-a1b2",
			}),
			TMP,
		);

		const config = makeConfig();
		const exec = makeExec((cmd) => {
			if (cmd[0] === "git" && cmd[1] === "branch" && cmd[2] === "--list") {
				return { exitCode: 0, stdout: "  greenhouse/testrepo-a1b2\n", stderr: "" };
			}
			// git checkout main fails (dirty worktree)
			if (cmd[0] === "git" && cmd[1] === "checkout") {
				return {
					exitCode: 1,
					stdout: "",
					stderr: "error: Your local changes would be overwritten",
				};
			}
			return null;
		});

		// Should not throw even when cleanup fails
		await expect(runPollCycle(config, exec)).resolves.toBeUndefined();
	});

	test("shipped run without mergeBranch: proactive scan skips it", async () => {
		await appendRun(makeRun({ status: "shipped", shippedAt: new Date().toISOString() }), TMP);

		const config = makeConfig();
		let branchListCalled = false;

		const exec = makeExec((cmd) => {
			if (cmd[0] === "git" && cmd[1] === "branch" && cmd[2] === "--list") {
				branchListCalled = true;
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return null;
		});

		await runPollCycle(config, exec);

		// No mergeBranch on the run → proactive scan skips it
		expect(branchListCalled).toBe(false);
	});
});

describe("supervisor timeout", () => {
	test("alive supervisor within timeout: no kill", async () => {
		const run = makeRun({
			status: "running",
			supervisorSessionName: "greenhouse-supervisor-testrepo-a1b2",
			supervisorSpawnedAt: new Date(Date.now() - 30 * 60_000).toISOString(), // 30 min ago
		});
		await appendRun(run, TMP);

		const config = makeConfig(); // run_timeout_minutes: 60
		let killSessionCalled = false;
		const exec = makeExec((cmd) => {
			if (cmd[0] === "tmux" && cmd[1] === "has-session") {
				return { exitCode: 0, stdout: "", stderr: "" }; // alive
			}
			if (cmd[0] === "tmux" && cmd[1] === "kill-session") {
				killSessionCalled = true;
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return null;
		});

		await runPollCycle(config, exec);

		expect(killSessionCalled).toBe(false);
		const runs = await readAllRuns(TMP);
		const result = runs.find((r) => r.seedsId === "testrepo-a1b2");
		expect(result?.status).toBe("running");
	});

	test("alive supervisor past timeout: kills session and marks run failed with retryable:true", async () => {
		const run = makeRun({
			status: "running",
			supervisorSessionName: "greenhouse-supervisor-testrepo-a1b2",
			supervisorSpawnedAt: new Date(Date.now() - 61 * 60_000).toISOString(), // 61 min ago
		});
		await appendRun(run, TMP);

		const config = makeConfig(); // run_timeout_minutes: 60
		let killSessionCalled = false;
		const exec = makeExec((cmd) => {
			if (cmd[0] === "tmux" && cmd[1] === "has-session") {
				return { exitCode: 0, stdout: "", stderr: "" }; // alive
			}
			if (cmd[0] === "tmux" && cmd[1] === "display-message") {
				return { exitCode: 0, stdout: "9999\n", stderr: "" };
			}
			if (cmd[0] === "pgrep") {
				return { exitCode: 1, stdout: "", stderr: "" }; // no children
			}
			if (cmd[0] === "tmux" && cmd[1] === "kill-session") {
				killSessionCalled = true;
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return null;
		});

		await runPollCycle(config, exec);

		expect(killSessionCalled).toBe(true);
		const runs = await readAllRuns(TMP);
		const latest = runs.filter((r) => r.seedsId === "testrepo-a1b2").at(-1);
		expect(latest?.status).toBe("failed");
		expect(latest?.retryable).toBe(true);
		expect(latest?.error).toMatch(/timed out/i);
	});

	test("alive supervisor past timeout falls back to dispatchedAt when no supervisorSpawnedAt", async () => {
		const run = makeRun({
			status: "running",
			supervisorSessionName: "greenhouse-supervisor-testrepo-a1b2",
			dispatchedAt: new Date(Date.now() - 61 * 60_000).toISOString(), // 61 min ago, no supervisorSpawnedAt
		});
		await appendRun(run, TMP);

		const config = makeConfig();
		let killSessionCalled = false;
		const exec = makeExec((cmd) => {
			if (cmd[0] === "tmux" && cmd[1] === "has-session") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (cmd[0] === "tmux" && cmd[1] === "display-message") {
				return { exitCode: 0, stdout: "9999\n", stderr: "" };
			}
			if (cmd[0] === "pgrep") {
				return { exitCode: 1, stdout: "", stderr: "" };
			}
			if (cmd[0] === "tmux" && cmd[1] === "kill-session") {
				killSessionCalled = true;
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return null;
		});

		await runPollCycle(config, exec);

		expect(killSessionCalled).toBe(true);
		const runs = await readAllRuns(TMP);
		const latest = runs.filter((r) => r.seedsId === "testrepo-a1b2").at(-1);
		expect(latest?.status).toBe("failed");
		expect(latest?.error).toMatch(/timed out/i);
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

describe("initLogFile and log file writing", () => {
	test("initLogFile creates daemon.log file", async () => {
		await initLogFile(TMP);
		// The log file directory should exist
		expect(existsSync(join(TMP, ".greenhouse"))).toBe(true);
	});

	test("log() writes to daemon.log after initLogFile()", async () => {
		await initLogFile(TMP);
		// Import runPollCycle so log() is triggered — use a no-op config
		const config = makeConfig();
		const exec = makeExec();
		await runPollCycle(config, exec);

		const logPath = join(TMP, ".greenhouse", "daemon.log");
		expect(existsSync(logPath)).toBe(true);
		const contents = readFileSync(logPath, "utf8");
		// runPollCycle calls log() with Poll cycle complete
		expect(contents).toContain("Poll cycle complete");
	});
});

describe("cleanupStaleSupervisors", () => {
	test("kills sessions not associated with active runs", async () => {
		// No active runs in state — all greenhouse-supervisor-* sessions are stale
		const config = makeConfig();
		const killedSessions: string[] = [];

		const exec = makeExec((cmd) => {
			if (cmd[0] === "tmux" && cmd[1] === "list-sessions") {
				return {
					exitCode: 0,
					stdout: "greenhouse-supervisor-testrepo-a1b2\nother-session\n",
					stderr: "",
				};
			}
			if (cmd[0] === "tmux" && cmd[1] === "display-message") {
				return { exitCode: 0, stdout: "9999\n", stderr: "" };
			}
			if (cmd[0] === "pgrep") {
				return { exitCode: 1, stdout: "", stderr: "" };
			}
			if (cmd[0] === "tmux" && cmd[1] === "kill-session") {
				killedSessions.push(cmd[3] ?? "");
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return null;
		});

		await cleanupStaleSupervisors(config, exec);

		// Only the greenhouse-supervisor- session should be killed (not other-session)
		expect(killedSessions).toContain("greenhouse-supervisor-testrepo-a1b2");
		expect(killedSessions).not.toContain("other-session");
	});

	test("preserves sessions associated with active runs", async () => {
		// Active run with supervisorSessionName set
		await appendRun(
			makeRun({
				status: "running",
				supervisorSessionName: "greenhouse-supervisor-testrepo-a1b2",
			}),
			TMP,
		);

		const config = makeConfig();
		let killCalled = false;

		const exec = makeExec((cmd) => {
			if (cmd[0] === "tmux" && cmd[1] === "list-sessions") {
				return {
					exitCode: 0,
					stdout: "greenhouse-supervisor-testrepo-a1b2\n",
					stderr: "",
				};
			}
			if (cmd[0] === "tmux" && cmd[1] === "kill-session") {
				killCalled = true;
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return null;
		});

		await cleanupStaleSupervisors(config, exec);

		// Active session should NOT be killed
		expect(killCalled).toBe(false);
	});

	test("no-op when tmux has no greenhouse-supervisor- sessions", async () => {
		const config = makeConfig();
		let killCalled = false;

		const exec = makeExec((cmd) => {
			if (cmd[0] === "tmux" && cmd[1] === "list-sessions") {
				return { exitCode: 0, stdout: "other-session\n", stderr: "" };
			}
			if (cmd[0] === "tmux" && cmd[1] === "kill-session") {
				killCalled = true;
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return null;
		});

		await cleanupStaleSupervisors(config, exec);
		expect(killCalled).toBe(false);
	});

	test("no-op when tmux list-sessions fails", async () => {
		const config = makeConfig();
		let killCalled = false;

		const exec = makeExec((cmd) => {
			if (cmd[0] === "tmux" && cmd[1] === "list-sessions") {
				return { exitCode: 1, stdout: "", stderr: "no server running" };
			}
			if (cmd[0] === "tmux" && cmd[1] === "kill-session") {
				killCalled = true;
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return null;
		});

		await cleanupStaleSupervisors(config, exec);
		expect(killCalled).toBe(false);
	});
});

describe("monitorSupervisors: daemon shipping when supervisor exits with seeds closed", () => {
	test("supervisor exits + seeds closed → daemon ships run", async () => {
		const run = makeRun({
			status: "running",
			supervisorSessionName: "greenhouse-supervisor-testrepo-a1b2",
			mergeBranch: "greenhouse/testrepo-a1b2",
		});
		await appendRun(run, TMP);

		const config = makeConfig();
		const exec = makeExec((cmd) => {
			// Supervisor is dead
			if (cmd[0] === "tmux" && cmd[1] === "has-session") {
				return { exitCode: 1, stdout: "", stderr: "can't find session" };
			}
			// git branch --list → no local branch (no proactive cleanup needed)
			if (cmd[0] === "git" && cmd[1] === "branch" && cmd[2] === "--list") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			// seeds show → closed
			if (cmd[0] === "sd" && cmd[1] === "show") {
				return {
					exitCode: 0,
					stdout: JSON.stringify({
						success: true,
						command: "show",
						issue: { id: "testrepo-a1b2", status: "closed" },
					}),
					stderr: "",
				};
			}
			// Pre-flight: git worktree list
			if (cmd[0] === "git" && cmd[1] === "worktree") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			// Pre-flight: bun test/lint/typecheck
			if (cmd[0] === "bun") {
				return { exitCode: 0, stdout: "All tests passed", stderr: "" };
			}
			// git diff (pre-ship validation)
			if (cmd[0] === "git" && cmd[1] === "diff") {
				return { exitCode: 1, stdout: "diff content", stderr: "" }; // non-zero → has commits
			}
			// git push (shipRun)
			if (cmd[0] === "git" && cmd[1] === "push") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			// gh pr create → PR URL
			if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "create") {
				return {
					exitCode: 0,
					stdout: "https://github.com/testowner/testrepo/pull/99\n",
					stderr: "",
				};
			}
			// gh issue comment
			if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "comment") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			// git checkout main (cleanupAfterShip)
			if (cmd[0] === "git" && cmd[1] === "checkout") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			// git branch -D (cleanupAfterShip)
			if (cmd[0] === "git" && cmd[1] === "branch") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			return null;
		});

		await runPollCycle(config, exec);

		const runs = await readAllRuns(TMP);
		const latest = runs.filter((r) => r.seedsId === "testrepo-a1b2").at(-1);
		expect(latest?.status).toBe("shipped");
		expect(latest?.prUrl).toBe("https://github.com/testowner/testrepo/pull/99");
		expect(latest?.prNumber).toBe(99);
	});

	test("supervisor exits + seeds NOT closed → marks run failed with retryable:true", async () => {
		const run = makeRun({
			status: "running",
			supervisorSessionName: "greenhouse-supervisor-testrepo-a1b2",
			mergeBranch: "greenhouse/testrepo-a1b2",
		});
		await appendRun(run, TMP);

		const config = makeConfig();
		const exec = makeExec((cmd) => {
			if (cmd[0] === "tmux" && cmd[1] === "has-session") {
				return { exitCode: 1, stdout: "", stderr: "can't find session" };
			}
			if (cmd[0] === "git" && cmd[1] === "branch" && cmd[2] === "--list") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			// seeds show → in_progress (not closed)
			if (cmd[0] === "sd" && cmd[1] === "show") {
				return {
					exitCode: 0,
					stdout: JSON.stringify({
						success: true,
						command: "show",
						issue: { id: "testrepo-a1b2", status: "in_progress" },
					}),
					stderr: "",
				};
			}
			return null;
		});

		await runPollCycle(config, exec);

		const runs = await readAllRuns(TMP);
		const latest = runs.filter((r) => r.seedsId === "testrepo-a1b2").at(-1);
		expect(latest?.status).toBe("failed");
		expect(latest?.retryable).toBe(true);
		expect(latest?.error).toMatch(/seeds not closed/i);
	});
});
