import { describe, expect, test } from "bun:test";
import { buildDispatchMessage, dispatchRun } from "./dispatcher.ts";
import type { DispatchContext, ExecResult, RepoConfig, SlingResult } from "./types.ts";

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

function makeSlingResult(overrides?: Partial<SlingResult>): SlingResult {
	return {
		success: true,
		command: "sling",
		agentName: "coordinator-overstory-a1b2",
		capability: "coordinator",
		taskId: "overstory-a1b2",
		branch: "overstory/coordinator-overstory-a1b2/overstory-a1b2",
		worktree: "/tmp/worktrees/coordinator",
		tmuxSession: "",
		pid: 12345,
		...overrides,
	};
}

describe("dispatchRun", () => {
	test("creates merge branch, dispatches with --base-branch, returns mergeBranch", async () => {
		const slingResult = makeSlingResult();
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			// git branch (create merge branch)
			if (cmd[0] === "git" && cmd[1] === "branch") {
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			// ov sling
			return {
				exitCode: 0,
				stdout: JSON.stringify(slingResult),
				stderr: "",
			};
		};

		const result = await dispatchRun("overstory-a1b2", testRepo, exec);

		expect(result.agentName).toBe("coordinator-overstory-a1b2");
		expect(result.branch).toBe("overstory/coordinator-overstory-a1b2/overstory-a1b2");
		expect(result.mergeBranch).toBe("greenhouse/overstory-a1b2");
		expect(result.taskId).toBe("overstory-a1b2");
		expect(result.pid).toBe(12345);
	});

	test("creates greenhouse merge branch before calling ov sling", async () => {
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			return {
				exitCode: 0,
				stdout: JSON.stringify(makeSlingResult()),
				stderr: "",
			};
		};

		await dispatchRun("overstory-a1b2", testRepo, exec);

		// First call should be git branch to create merge branch
		expect(calls[0]).toEqual(["git", "branch", "greenhouse/overstory-a1b2", "HEAD"]);
	});

	test("passes --base-branch to ov sling", async () => {
		let slingCmd: string[] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			slingCmd = cmd;
			return {
				exitCode: 0,
				stdout: JSON.stringify(makeSlingResult()),
				stderr: "",
			};
		};

		await dispatchRun("overstory-a1b2", testRepo, exec);

		expect(slingCmd).toContain("--base-branch");
		const baseBranchIdx = slingCmd.indexOf("--base-branch");
		expect(slingCmd[baseBranchIdx + 1]).toBe("greenhouse/overstory-a1b2");
	});

	test("calls ov sling with correct args and cwd", async () => {
		let capturedCmd: string[] = [];
		let capturedCwd: string | undefined;
		const exec = async (cmd: string[], opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			capturedCmd = cmd;
			capturedCwd = opts?.cwd;
			return {
				exitCode: 0,
				stdout: JSON.stringify(makeSlingResult()),
				stderr: "",
			};
		};

		await dispatchRun("overstory-a1b2", testRepo, exec);

		expect(capturedCmd).toContain("ov");
		expect(capturedCmd).toContain("sling");
		expect(capturedCmd).toContain("overstory-a1b2");
		expect(capturedCmd).toContain("--json");
		expect(capturedCwd).toBe(testRepo.project_root);
	});

	test("defaults to coordinator capability", async () => {
		let capturedCmd: string[] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			capturedCmd = cmd;
			return {
				exitCode: 0,
				stdout: JSON.stringify(makeSlingResult()),
				stderr: "",
			};
		};

		await dispatchRun("overstory-a1b2", testRepo, exec);

		expect(capturedCmd).toContain("--capability");
		const capIdx = capturedCmd.indexOf("--capability");
		expect(capturedCmd[capIdx + 1]).toBe("coordinator");
	});

	test("uses provided capability from options", async () => {
		let capturedCmd: string[] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			capturedCmd = cmd;
			return {
				exitCode: 0,
				stdout: JSON.stringify(makeSlingResult()),
				stderr: "",
			};
		};

		await dispatchRun("overstory-a1b2", testRepo, exec, { capability: "lead" });

		const capIdx = capturedCmd.indexOf("--capability");
		expect(capturedCmd[capIdx + 1]).toBe("lead");
	});

	test("passes --spec when context is provided", async () => {
		let capturedCmd: string[] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			capturedCmd = cmd;
			return {
				exitCode: 0,
				stdout: JSON.stringify(makeSlingResult()),
				stderr: "",
			};
		};

		await dispatchRun("overstory-a1b2", testRepo, exec, { context: testContext });

		expect(capturedCmd).toContain("--spec");
		const specIdx = capturedCmd.indexOf("--spec");
		expect(capturedCmd[specIdx + 1]).toContain("overstory-a1b2-spec.md");
	});

	test("does not pass --spec when no context provided", async () => {
		let capturedCmd: string[] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			capturedCmd = cmd;
			return {
				exitCode: 0,
				stdout: JSON.stringify(makeSlingResult()),
				stderr: "",
			};
		};

		await dispatchRun("overstory-a1b2", testRepo, exec);

		expect(capturedCmd).not.toContain("--spec");
	});

	test("throws on non-zero exit from ov sling", async () => {
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "ov: no tmux session" };
		};
		await expect(dispatchRun("overstory-a1b2", testRepo, exec)).rejects.toThrow("ov sling failed");
	});

	test("throws when merge branch creation fails", async () => {
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git") return { exitCode: 1, stdout: "", stderr: "branch already exists" };
			return { exitCode: 0, stdout: JSON.stringify(makeSlingResult()), stderr: "" };
		};
		await expect(dispatchRun("overstory-a1b2", testRepo, exec)).rejects.toThrow(
			"Failed to create merge branch",
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
