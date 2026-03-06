import { describe, expect, test } from "bun:test";
import { checkRunStatus } from "./monitor.ts";
import type { ExecResult, OvStatusResult, RepoConfig, SdIssue } from "./types.ts";

const testRepo: RepoConfig = {
	owner: "jayminwest",
	repo: "overstory",
	labels: ["agent-ready"],
	project_root: "/tmp/test-repo",
};

function makeExec(...results: [ExecResult, ...ExecResult[]]) {
	let call = 0;
	return async (_cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
		const result = (
			call < results.length ? results[call] : results[results.length - 1]
		) as ExecResult;
		call++;
		return result;
	};
}

function makeSdShowResponse(status: string): { success: boolean; command: string; issue: SdIssue } {
	return {
		success: true,
		command: "show",
		issue: {
			id: "greenhouse-test",
			title: "Test issue",
			status,
			createdAt: "2026-03-06T00:00:00.000Z",
			updatedAt: "2026-03-06T00:00:00.000Z",
		},
	};
}

function makeOvStatus(
	agents: Array<{ taskId: string; capability: string; state: string }>,
): OvStatusResult {
	return {
		success: true,
		command: "status",
		currentRunId: "run-test",
		agents: agents.map((a, i) => ({
			id: `session-${i}`,
			agentName: `agent-${i}`,
			capability: a.capability,
			worktreePath: "/tmp/worktree",
			branchName: "main",
			taskId: a.taskId,
			tmuxSession: `overstory-${i}`,
			state: a.state,
			pid: 1000 + i,
			parentAgent: null,
			depth: 1,
			runId: "run-test",
			startedAt: "2026-03-06T00:00:00.000Z",
			lastActivity: "2026-03-06T00:00:00.000Z",
			escalationLevel: 0,
			stalledSince: null,
			transcriptPath: null,
		})),
	};
}

describe("checkRunStatus", () => {
	test("returns completed=true when seeds issue is closed", async () => {
		const exec = makeExec({
			exitCode: 0,
			stdout: JSON.stringify(makeSdShowResponse("closed")),
			stderr: "",
		});

		const result = await checkRunStatus("greenhouse-test", testRepo, exec);
		expect(result.completed).toBe(true);
		expect(result.state).toBe("closed");
		expect(result.failed).toBeUndefined();
	});

	test("returns completed=false when issue is in_progress and task agents are running", async () => {
		const exec = makeExec(
			{ exitCode: 0, stdout: JSON.stringify(makeSdShowResponse("in_progress")), stderr: "" },
			{
				exitCode: 0,
				stdout: JSON.stringify(
					makeOvStatus([
						{ taskId: "greenhouse-test", capability: "lead", state: "working" },
						{ taskId: "", capability: "coordinator", state: "working" },
					]),
				),
				stderr: "",
			},
		);

		const result = await checkRunStatus("greenhouse-test", testRepo, exec);
		expect(result.completed).toBe(false);
		expect(result.state).toBe("in_progress");
	});

	test("ignores coordinator when checking task agents", async () => {
		// Coordinator has empty taskId and capability=coordinator — should not count as a task agent
		const exec = makeExec(
			{ exitCode: 0, stdout: JSON.stringify(makeSdShowResponse("in_progress")), stderr: "" },
			{
				exitCode: 0,
				stdout: JSON.stringify(
					makeOvStatus([{ taskId: "", capability: "coordinator", state: "working" }]),
				),
				stderr: "",
			},
		);

		const result = await checkRunStatus("greenhouse-test", testRepo, exec);
		expect(result.completed).toBe(true);
		expect(result.state).toBe("failed");
		expect(result.failed).toBe(true);
		expect(result.retryable).toBe(true);
	});

	test("returns failed+retryable when ov status exits non-zero", async () => {
		const exec = makeExec(
			{ exitCode: 0, stdout: JSON.stringify(makeSdShowResponse("in_progress")), stderr: "" },
			{ exitCode: 1, stdout: "", stderr: "ov: not found" },
		);

		const result = await checkRunStatus("greenhouse-test", testRepo, exec);
		expect(result.completed).toBe(true);
		expect(result.state).toBe("failed");
		expect(result.failed).toBe(true);
		expect(result.retryable).toBe(true);
	});

	test("returns failed+retryable when no task-specific agents found", async () => {
		// Only agents for a different taskId — no agents for greenhouse-test
		const exec = makeExec(
			{ exitCode: 0, stdout: JSON.stringify(makeSdShowResponse("in_progress")), stderr: "" },
			{
				exitCode: 0,
				stdout: JSON.stringify(
					makeOvStatus([
						{ taskId: "greenhouse-other", capability: "lead", state: "working" },
						{ taskId: "", capability: "coordinator", state: "working" },
					]),
				),
				stderr: "",
			},
		);

		const result = await checkRunStatus("greenhouse-test", testRepo, exec);
		expect(result.completed).toBe(true);
		expect(result.state).toBe("failed");
		expect(result.failed).toBe(true);
		expect(result.retryable).toBe(true);
	});

	test("throws when sd show fails", async () => {
		const exec = makeExec({ exitCode: 1, stdout: "", stderr: "sd: issue not found" });
		await expect(checkRunStatus("greenhouse-test", testRepo, exec)).rejects.toThrow(
			"sd show failed",
		);
	});
});
