import { describe, expect, test } from "bun:test";
import { dispatchRun } from "./dispatcher.ts";
import type { ExecResult, RepoConfig, SlingResult } from "./types.ts";

const testRepo: RepoConfig = {
	owner: "jayminwest",
	repo: "overstory",
	labels: ["agent-ready"],
	project_root: "/tmp/test-repo",
};

function makeSlingResult(overrides?: Partial<SlingResult>): SlingResult {
	return {
		success: true,
		command: "sling",
		agentName: "lead-overstory-a1b2",
		capability: "lead",
		taskId: "overstory-a1b2",
		branch: "overstory/lead-overstory-a1b2/overstory-a1b2",
		worktree: "/tmp/worktrees/lead",
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

		expect(result.agentName).toBe("lead-overstory-a1b2");
		expect(result.branch).toBe("overstory/lead-overstory-a1b2/overstory-a1b2");
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
