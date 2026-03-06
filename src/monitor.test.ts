import { describe, expect, test } from "bun:test";
import { checkRunStatus } from "./monitor.ts";
import type { CoordinatorStatus, ExecResult, RepoConfig, SdIssue } from "./types.ts";

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

function makeSdIssue(status: string): SdIssue {
	return {
		id: "greenhouse-test",
		title: "Test issue",
		status,
		createdAt: "2026-03-06T00:00:00.000Z",
		updatedAt: "2026-03-06T00:00:00.000Z",
	};
}

function makeCoordStatus(alive: boolean): CoordinatorStatus {
	return { alive };
}

describe("checkRunStatus", () => {
	test("returns completed=true when seeds issue is closed", async () => {
		const exec = makeExec({
			exitCode: 0,
			stdout: JSON.stringify(makeSdIssue("closed")),
			stderr: "",
		});

		const result = await checkRunStatus("greenhouse-test", testRepo, exec);
		expect(result.completed).toBe(true);
		expect(result.state).toBe("closed");
		expect(result.failed).toBeUndefined();
	});

	test("returns completed=false when issue is in_progress and coordinator alive", async () => {
		const exec = makeExec(
			{ exitCode: 0, stdout: JSON.stringify(makeSdIssue("in_progress")), stderr: "" },
			{ exitCode: 0, stdout: JSON.stringify(makeCoordStatus(true)), stderr: "" },
		);

		const result = await checkRunStatus("greenhouse-test", testRepo, exec);
		expect(result.completed).toBe(false);
		expect(result.state).toBe("in_progress");
	});

	test("returns failed+retryable when coordinator exits non-zero", async () => {
		const exec = makeExec(
			{ exitCode: 0, stdout: JSON.stringify(makeSdIssue("in_progress")), stderr: "" },
			{ exitCode: 1, stdout: "", stderr: "coordinator: not found" },
		);

		const result = await checkRunStatus("greenhouse-test", testRepo, exec);
		expect(result.completed).toBe(true);
		expect(result.state).toBe("failed");
		expect(result.failed).toBe(true);
		expect(result.retryable).toBe(true);
	});

	test("returns failed+retryable when coordinator reports alive=false", async () => {
		const exec = makeExec(
			{ exitCode: 0, stdout: JSON.stringify(makeSdIssue("in_progress")), stderr: "" },
			{ exitCode: 0, stdout: JSON.stringify(makeCoordStatus(false)), stderr: "" },
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
