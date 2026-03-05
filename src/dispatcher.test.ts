import { describe, expect, test } from "bun:test";
import { dispatchRun } from "./dispatcher.ts";
import type { ExecResult, RepoConfig, SlingResult } from "./types.ts";

const testRepo: RepoConfig = {
	owner: "jayminwest",
	repo: "overstory",
	labels: ["agent-ready"],
	project_root: "/tmp/test-repo",
};

function makeExec(result: ExecResult) {
	return async (_cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => result;
}

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
	test("parses ov sling JSON and returns agent info", async () => {
		const slingResult = makeSlingResult();
		const exec = makeExec({
			exitCode: 0,
			stdout: JSON.stringify(slingResult),
			stderr: "",
		});

		const result = await dispatchRun("overstory-a1b2", testRepo, exec);

		expect(result.agentName).toBe("lead-overstory-a1b2");
		expect(result.branch).toBe("overstory/lead-overstory-a1b2/overstory-a1b2");
		expect(result.taskId).toBe("overstory-a1b2");
		expect(result.pid).toBe(12345);
	});

	test("calls ov sling with correct args and cwd", async () => {
		let capturedCmd: string[] = [];
		let capturedCwd: string | undefined;
		const exec = async (cmd: string[], opts?: { cwd?: string }): Promise<ExecResult> => {
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

	test("throws on non-zero exit", async () => {
		const exec = makeExec({ exitCode: 1, stdout: "", stderr: "ov: no tmux session" });
		await expect(dispatchRun("overstory-a1b2", testRepo, exec)).rejects.toThrow("ov sling failed");
	});
});
