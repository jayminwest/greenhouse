import { describe, expect, test } from "bun:test";
import { pollIssues } from "./poller.ts";
import type { ExecResult, GhIssue, RepoConfig } from "./types.ts";

const testRepo: RepoConfig = {
	owner: "jayminwest",
	repo: "overstory",
	labels: ["agent-ready"],
	project_root: "/tmp/test-repo",
};

function makeExec(result: ExecResult) {
	return async (_cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => result;
}

describe("pollIssues", () => {
	test("returns issues from valid JSON response", async () => {
		const issues: GhIssue[] = [
			{
				number: 42,
				title: "Fix the thing",
				body: "It is broken.",
				labels: [{ name: "agent-ready" }],
				assignees: [],
			},
		];

		const exec = makeExec({ exitCode: 0, stdout: JSON.stringify(issues), stderr: "" });
		const result = await pollIssues(testRepo, exec);

		expect(result).toHaveLength(1);
		expect(result[0]?.number).toBe(42);
		expect(result[0]?.title).toBe("Fix the thing");
	});

	test("returns empty array when no issues", async () => {
		const exec = makeExec({ exitCode: 0, stdout: "[]", stderr: "" });
		const result = await pollIssues(testRepo, exec);
		expect(result).toHaveLength(0);
	});

	test("includes all labels as separate --label flags", async () => {
		const multiLabelRepo: RepoConfig = {
			...testRepo,
			labels: ["agent-ready", "approved"],
		};

		let capturedCmd: string[] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			capturedCmd = cmd;
			return { exitCode: 0, stdout: "[]", stderr: "" };
		};

		await pollIssues(multiLabelRepo, exec);

		// Verify both labels are passed as separate --label flags
		const labelIndexes = capturedCmd.reduce<number[]>((acc, v, i) => {
			if (v === "--label") acc.push(i);
			return acc;
		}, []);

		expect(labelIndexes).toHaveLength(2);
		const [idx0, idx1] = labelIndexes;
		expect(capturedCmd[Number(idx0) + 1]).toBe("agent-ready");
		expect(capturedCmd[Number(idx1) + 1]).toBe("approved");
	});

	test("throws on non-zero exit code", async () => {
		const exec = makeExec({ exitCode: 1, stdout: "", stderr: "gh: authentication required" });
		await expect(pollIssues(testRepo, exec)).rejects.toThrow("gh issue list failed");
	});
});
