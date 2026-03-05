import { describe, expect, test } from "bun:test";
import { checkRunStatus } from "./monitor.ts";
import type { AgentStatus, ExecResult, RepoConfig, StatusResult } from "./types.ts";

const testRepo: RepoConfig = {
	owner: "jayminwest",
	repo: "overstory",
	labels: ["agent-ready"],
	project_root: "/tmp/test-repo",
};

function makeExec(result: ExecResult) {
	return async (_cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => result;
}

function makeStatusResult(agents: AgentStatus[]): StatusResult {
	return {
		success: true,
		command: "status",
		currentRunId: null,
		agents,
		worktrees: [],
		tmuxSessions: [],
		unreadMailCount: 0,
		mergeQueueCount: 0,
		recentMetricsCount: 0,
	};
}

describe("checkRunStatus", () => {
	test("returns completed=true for 'completed' state", async () => {
		const agents: AgentStatus[] = [
			{
				agentName: "lead-test",
				capability: "lead",
				taskId: "overstory-a1b2",
				branch: "overstory/lead-test/overstory-a1b2",
				state: "completed",
			},
		];
		const exec = makeExec({
			exitCode: 0,
			stdout: JSON.stringify(makeStatusResult(agents)),
			stderr: "",
		});

		const result = await checkRunStatus("overstory-a1b2", testRepo, exec);
		expect(result.completed).toBe(true);
		expect(result.state).toBe("completed");
	});

	test("returns completed=true for 'zombie' state", async () => {
		const agents: AgentStatus[] = [
			{
				agentName: "lead-test",
				capability: "lead",
				taskId: "overstory-a1b2",
				branch: "overstory/lead-test/overstory-a1b2",
				state: "zombie",
			},
		];
		const exec = makeExec({
			exitCode: 0,
			stdout: JSON.stringify(makeStatusResult(agents)),
			stderr: "",
		});

		const result = await checkRunStatus("overstory-a1b2", testRepo, exec);
		expect(result.completed).toBe(true);
	});

	test("returns completed=false for 'working' state", async () => {
		const agents: AgentStatus[] = [
			{
				agentName: "lead-test",
				capability: "lead",
				taskId: "overstory-a1b2",
				branch: "overstory/lead-test/overstory-a1b2",
				state: "working",
			},
		];
		const exec = makeExec({
			exitCode: 0,
			stdout: JSON.stringify(makeStatusResult(agents)),
			stderr: "",
		});

		const result = await checkRunStatus("overstory-a1b2", testRepo, exec);
		expect(result.completed).toBe(false);
		expect(result.state).toBe("working");
	});

	test("returns completed=true when agent not found (already cleaned up)", async () => {
		const exec = makeExec({
			exitCode: 0,
			stdout: JSON.stringify(makeStatusResult([])),
			stderr: "",
		});

		const result = await checkRunStatus("overstory-missing", testRepo, exec);
		expect(result.completed).toBe(true);
		expect(result.state).toBe("completed");
	});

	test("throws on ov status failure", async () => {
		const exec = makeExec({ exitCode: 1, stdout: "", stderr: "ov: not initialized" });
		await expect(checkRunStatus("overstory-a1b2", testRepo, exec)).rejects.toThrow(
			"ov status failed",
		);
	});
});
