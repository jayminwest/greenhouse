import { describe, expect, test } from "bun:test";
import { cleanupAfterFailure } from "./cleanup.ts";
import type { ExecResult, RepoConfig, RunState } from "./types.ts";

const testRepo: RepoConfig = {
	owner: "jayminwest",
	repo: "overstory",
	labels: ["agent-ready"],
	project_root: "/tmp/test-repo",
};

function makeRun(overrides?: Partial<RunState>): RunState {
	const now = new Date().toISOString();
	return {
		ghIssueId: 42,
		ghRepo: "jayminwest/overstory",
		ghTitle: "Fix retry logic",
		ghLabels: ["agent-ready"],
		seedsId: "overstory-a1b2",
		status: "failed",
		mergeBranch: "greenhouse/overstory-a1b2",
		discoveredAt: now,
		updatedAt: now,
		...overrides,
	};
}

describe("cleanupAfterFailure", () => {
	test("runs all cleanup steps in order", async () => {
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await cleanupAfterFailure(makeRun(), testRepo, "run timeout exceeded", true, exec);

		expect(calls[0]).toEqual(["git", "checkout", "main"]);
		expect(calls[1]).toEqual(["git", "branch", "-D", "greenhouse/overstory-a1b2"]);
		expect(calls[2]).toEqual(["ov", "worktree", "clean", "--completed"]);
		// spec file removal
		expect(calls[3]?.[0]).toBe("rm");
		expect(calls[3]?.join(" ")).toContain("overstory-a1b2-spec.md");
		// gh issue comment
		expect(calls[4]).toContain("gh");
		expect(calls[4]).toContain("issue");
		expect(calls[4]).toContain("comment");
	});

	test("posts retryable label when retryable=true", async () => {
		let commentBody = "";
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd.includes("comment")) {
				const bodyIdx = cmd.indexOf("--body");
				commentBody = cmd[bodyIdx + 1] ?? "";
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await cleanupAfterFailure(makeRun(), testRepo, "agents timed out", true, exec);

		expect(commentBody).toContain("retryable");
		expect(commentBody).toContain("agents timed out");
	});

	test("posts terminal label when retryable=false", async () => {
		let commentBody = "";
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd.includes("comment")) {
				const bodyIdx = cmd.indexOf("--body");
				commentBody = cmd[bodyIdx + 1] ?? "";
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await cleanupAfterFailure(makeRun(), testRepo, "dispatch failed", false, exec);

		expect(commentBody).toContain("terminal");
		expect(commentBody).toContain("dispatch failed");
	});

	test("uses mergeBranch when set", async () => {
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await cleanupAfterFailure(
			makeRun({ mergeBranch: "greenhouse/overstory-a1b2" }),
			testRepo,
			"error",
			true,
			exec,
		);

		const deleteBranch = calls.find((c) => c[1] === "branch" && c[2] === "-D");
		expect(deleteBranch).toContain("greenhouse/overstory-a1b2");
	});

	test("falls back to greenhouse/<seedsId> when mergeBranch is not set", async () => {
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await cleanupAfterFailure(makeRun({ mergeBranch: undefined }), testRepo, "error", true, exec);

		const deleteBranch = calls.find((c) => c[1] === "branch" && c[2] === "-D");
		expect(deleteBranch).toContain("greenhouse/overstory-a1b2");
	});

	test("passes correct repo to gh issue comment", async () => {
		let commentCmd: string[] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd.includes("comment")) commentCmd = cmd;
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await cleanupAfterFailure(makeRun(), testRepo, "error", true, exec);

		expect(commentCmd).toContain("--repo");
		const repoIdx = commentCmd.indexOf("--repo");
		expect(commentCmd[repoIdx + 1]).toBe("jayminwest/overstory");
		expect(commentCmd).toContain(String(42));
	});

	test("continues if one step throws", async () => {
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			if (cmd[1] === "checkout") throw new Error("detached HEAD");
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await expect(
			cleanupAfterFailure(makeRun(), testRepo, "error", true, exec),
		).resolves.toBeUndefined();

		const cmds = calls.map((c) => c.slice(0, 3).join(" "));
		expect(cmds).toContain("git branch -D");
		expect(cmds).toContain("ov worktree clean");
	});

	test("continues if one step returns non-zero exit code", async () => {
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			if (cmd[1] === "branch") return { exitCode: 1, stdout: "", stderr: "branch not found" };
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await expect(
			cleanupAfterFailure(makeRun(), testRepo, "error", true, exec),
		).resolves.toBeUndefined();
		// All 5 steps still ran
		expect(calls).toHaveLength(5);
	});
});
