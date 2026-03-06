import { describe, expect, test } from "bun:test";
import { buildDispatchMessage, dispatchRun } from "./dispatcher.ts";
import type {
	CoordinatorSendResult,
	CoordinatorStatus,
	DispatchContext,
	ExecResult,
	RepoConfig,
} from "./types.ts";

const testRepo: RepoConfig = {
	owner: "jayminwest",
	repo: "overstory",
	labels: ["agent-ready"],
	project_root: "/tmp/test-repo",
};

const testContext: DispatchContext = {
	seedsTitle: "fix: retry logic in mail client",
	ghIssueNumber: 42,
	ghRepo: "jayminwest/overstory",
	ghIssueBody: "The mail client fails to retry on transient errors.",
	ghLabels: ["agent-ready", "type:bug", "priority:P1"],
};

function makeCoordStatus(running: boolean): CoordinatorStatus {
	return {
		success: true,
		command: "coordinator status",
		running,
		watchdogRunning: false,
		monitorRunning: false,
	};
}

function makeCoordSendResult(overrides?: Partial<CoordinatorSendResult>): CoordinatorSendResult {
	return {
		success: true,
		command: "coordinator send",
		id: "mail-abc123",
		nudged: true,
		...overrides,
	};
}

describe("dispatchRun", () => {
	test("creates merge branch, ensures coordinator, sends dispatch, returns result", async () => {
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			// git branch/checkout (create + setup merge branch)
			if (cmd[0] === "git") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			// ov coordinator status
			if (cmd[0] === "ov" && cmd[1] === "coordinator" && cmd[2] === "status") {
				return {
					exitCode: 0,
					stdout: JSON.stringify(makeCoordStatus(true)),
					stderr: "",
				};
			}
			// ov coordinator send
			if (cmd[0] === "ov" && cmd[1] === "coordinator" && cmd[2] === "send") {
				return {
					exitCode: 0,
					stdout: JSON.stringify(makeCoordSendResult()),
					stderr: "",
				};
			}
			return { exitCode: 1, stdout: "", stderr: "unexpected command" };
		};

		const result = await dispatchRun("overstory-a1b2", testRepo, exec);

		expect(result.agentName).toBe("coordinator");
		expect(result.mergeBranch).toBe("greenhouse/overstory-a1b2");
		expect(result.mailId).toBe("mail-abc123");
	});

	test("creates greenhouse merge branch before dispatching", async () => {
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			if (cmd[1] === "coordinator" && cmd[2] === "status") {
				return { exitCode: 0, stdout: JSON.stringify(makeCoordStatus(true)), stderr: "" };
			}
			if (cmd[1] === "coordinator" && cmd[2] === "send") {
				return { exitCode: 0, stdout: JSON.stringify(makeCoordSendResult()), stderr: "" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await dispatchRun("overstory-a1b2", testRepo, exec);

		expect(calls[0]).toEqual(["git", "branch", "greenhouse/overstory-a1b2", "HEAD"]);
	});

	test("starts coordinator if not running", async () => {
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			if (cmd[1] === "coordinator" && cmd[2] === "status") {
				return { exitCode: 0, stdout: JSON.stringify(makeCoordStatus(false)), stderr: "" };
			}
			if (cmd[1] === "coordinator" && cmd[2] === "start") {
				return {
					exitCode: 0,
					stdout: JSON.stringify({
						success: true,
						command: "coordinator start",
						agentName: "coordinator",
						capability: "coordinator",
						tmuxSession: "ov-coord",
						projectRoot: "/tmp/test-repo",
						pid: 12345,
						watchdog: true,
						monitor: false,
					}),
					stderr: "",
				};
			}
			if (cmd[1] === "coordinator" && cmd[2] === "send") {
				return { exitCode: 0, stdout: JSON.stringify(makeCoordSendResult()), stderr: "" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await dispatchRun("overstory-a1b2", testRepo, exec);

		const startCall = calls.find((c) => c[1] === "coordinator" && c[2] === "start");
		expect(startCall).toBeDefined();
		expect(startCall).toContain("--watchdog");
	});

	test("skips coordinator start if already running", async () => {
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			if (cmd[1] === "coordinator" && cmd[2] === "status") {
				return { exitCode: 0, stdout: JSON.stringify(makeCoordStatus(true)), stderr: "" };
			}
			if (cmd[1] === "coordinator" && cmd[2] === "send") {
				return { exitCode: 0, stdout: JSON.stringify(makeCoordSendResult()), stderr: "" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await dispatchRun("overstory-a1b2", testRepo, exec);

		const startCall = calls.find((c) => c[1] === "coordinator" && c[2] === "start");
		expect(startCall).toBeUndefined();
	});

	test("sends dispatch with correct subject when context provided", async () => {
		let sendCmd: string[] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			if (cmd[1] === "coordinator" && cmd[2] === "status") {
				return { exitCode: 0, stdout: JSON.stringify(makeCoordStatus(true)), stderr: "" };
			}
			if (cmd[1] === "coordinator" && cmd[2] === "send") {
				sendCmd = cmd;
				return { exitCode: 0, stdout: JSON.stringify(makeCoordSendResult()), stderr: "" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await dispatchRun("overstory-a1b2", testRepo, exec, { context: testContext });

		const subjectIdx = sendCmd.indexOf("--subject");
		expect(subjectIdx).toBeGreaterThan(-1);
		expect(sendCmd[subjectIdx + 1]).toBe("Objective: fix: retry logic in mail client");
	});

	test("sends generic subject when no context provided", async () => {
		let sendCmd: string[] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			if (cmd[1] === "coordinator" && cmd[2] === "status") {
				return { exitCode: 0, stdout: JSON.stringify(makeCoordStatus(true)), stderr: "" };
			}
			if (cmd[1] === "coordinator" && cmd[2] === "send") {
				sendCmd = cmd;
				return { exitCode: 0, stdout: JSON.stringify(makeCoordSendResult()), stderr: "" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await dispatchRun("overstory-a1b2", testRepo, exec);

		const subjectIdx = sendCmd.indexOf("--subject");
		expect(sendCmd[subjectIdx + 1]).toBe("Objective: implement overstory-a1b2");
	});

	test("passes --json to coordinator send", async () => {
		let sendCmd: string[] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			if (cmd[1] === "coordinator" && cmd[2] === "status") {
				return { exitCode: 0, stdout: JSON.stringify(makeCoordStatus(true)), stderr: "" };
			}
			if (cmd[1] === "coordinator" && cmd[2] === "send") {
				sendCmd = cmd;
				return { exitCode: 0, stdout: JSON.stringify(makeCoordSendResult()), stderr: "" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await dispatchRun("overstory-a1b2", testRepo, exec);

		expect(sendCmd).toContain("--json");
	});

	test("throws on non-zero exit from coordinator send", async () => {
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			if (cmd[1] === "coordinator" && cmd[2] === "status") {
				return { exitCode: 0, stdout: JSON.stringify(makeCoordStatus(true)), stderr: "" };
			}
			return { exitCode: 1, stdout: "", stderr: "coordinator: not alive" };
		};
		await expect(dispatchRun("overstory-a1b2", testRepo, exec)).rejects.toThrow(
			"ov coordinator send failed",
		);
	});

	test("throws when merge branch creation fails", async () => {
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git") return { exitCode: 1, stdout: "", stderr: "branch already exists" };
			return { exitCode: 0, stdout: JSON.stringify(makeCoordSendResult()), stderr: "" };
		};
		await expect(dispatchRun("overstory-a1b2", testRepo, exec)).rejects.toThrow(
			"Failed to create merge branch",
		);
	});

	test("throws when coordinator start fails", async () => {
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			if (cmd[1] === "coordinator" && cmd[2] === "status") {
				return { exitCode: 0, stdout: JSON.stringify(makeCoordStatus(false)), stderr: "" };
			}
			if (cmd[1] === "coordinator" && cmd[2] === "start") {
				return { exitCode: 1, stdout: "", stderr: "failed to start" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		await expect(dispatchRun("overstory-a1b2", testRepo, exec)).rejects.toThrow(
			"ov coordinator start failed",
		);
	});
});

describe("dispatchRun session-branch setup", () => {
	test("checks out the merge branch after creating it", async () => {
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			if (cmd[1] === "coordinator" && cmd[2] === "status") {
				return { exitCode: 0, stdout: JSON.stringify(makeCoordStatus(true)), stderr: "" };
			}
			if (cmd[1] === "coordinator" && cmd[2] === "send") {
				return { exitCode: 0, stdout: JSON.stringify(makeCoordSendResult()), stderr: "" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await dispatchRun("overstory-a1b2", testRepo, exec);

		const checkoutCall = calls.find((c) => c[0] === "git" && c[1] === "checkout");
		expect(checkoutCall).toBeDefined();
		expect(checkoutCall).toEqual(["git", "checkout", "greenhouse/overstory-a1b2"]);
	});

	test("checkout happens after branch creation and before coordinator", async () => {
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			if (cmd[1] === "coordinator" && cmd[2] === "status") {
				return { exitCode: 0, stdout: JSON.stringify(makeCoordStatus(true)), stderr: "" };
			}
			if (cmd[1] === "coordinator" && cmd[2] === "send") {
				return { exitCode: 0, stdout: JSON.stringify(makeCoordSendResult()), stderr: "" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await dispatchRun("overstory-a1b2", testRepo, exec);

		const branchIdx = calls.findIndex((c) => c[0] === "git" && c[1] === "branch");
		const checkoutIdx = calls.findIndex((c) => c[0] === "git" && c[1] === "checkout");
		const statusIdx = calls.findIndex((c) => c[1] === "coordinator" && c[2] === "status");
		expect(branchIdx).toBeLessThan(checkoutIdx);
		expect(checkoutIdx).toBeLessThan(statusIdx);
	});

	test("throws when checkout of merge branch fails", async () => {
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git" && cmd[1] === "branch") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (cmd[0] === "git" && cmd[1] === "checkout") {
				return { exitCode: 1, stdout: "", stderr: "pathspec not found" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		await expect(dispatchRun("overstory-a1b2", testRepo, exec)).rejects.toThrow(
			"Failed to checkout merge branch",
		);
	});
});

describe("buildDispatchMessage", () => {
	test("includes seeds ID and title", () => {
		const msg = buildDispatchMessage("overstory-a1b2", "greenhouse/overstory-a1b2", testContext);
		expect(msg).toContain("overstory-a1b2");
		expect(msg).toContain("fix: retry logic in mail client");
	});

	test("includes GitHub issue number and repo", () => {
		const msg = buildDispatchMessage("overstory-a1b2", "greenhouse/overstory-a1b2", testContext);
		expect(msg).toContain("#42");
		expect(msg).toContain("jayminwest/overstory");
	});

	test("includes base branch name", () => {
		const msg = buildDispatchMessage("overstory-a1b2", "greenhouse/overstory-a1b2", testContext);
		expect(msg).toContain("greenhouse/overstory-a1b2");
	});

	test("includes coordinator instructions for closing seeds issue", () => {
		const msg = buildDispatchMessage("overstory-a1b2", "greenhouse/overstory-a1b2", testContext);
		expect(msg).toContain("sd close overstory-a1b2");
	});

	test("includes issue body", () => {
		const msg = buildDispatchMessage("overstory-a1b2", "greenhouse/overstory-a1b2", testContext);
		expect(msg).toContain("The mail client fails to retry on transient errors.");
	});

	test("includes labels", () => {
		const msg = buildDispatchMessage("overstory-a1b2", "greenhouse/overstory-a1b2", testContext);
		expect(msg).toContain("agent-ready");
		expect(msg).toContain("type:bug");
		expect(msg).toContain("priority:P1");
	});

	test("includes critical ordering: close seeds issue last", () => {
		const msg = buildDispatchMessage("overstory-a1b2", "greenhouse/overstory-a1b2", testContext);
		expect(msg).toContain("Close** the seeds issue LAST");
		expect(msg).toContain("Do NOT close it until");
		expect(msg).toContain("ship an empty PR");
	});

	test("handles missing optional fields gracefully", () => {
		const minimalContext: DispatchContext = {
			seedsTitle: "simple task",
			ghIssueNumber: 1,
			ghRepo: "owner/repo",
		};
		const msg = buildDispatchMessage("repo-0001", "greenhouse/repo-0001", minimalContext);
		expect(msg).toContain("simple task");
		expect(msg).toContain("(no description provided)");
		expect(msg).toContain("(none)");
	});
});
