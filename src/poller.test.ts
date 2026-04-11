import { describe, expect, test } from "bun:test";
import { pollIssues } from "./poller.ts";
import type { ExecResult, GhIssue, RepoConfig } from "./types.ts";

const testRepo: RepoConfig = {
	owner: "jayminwest",
	repo: "overstory",
	ready_label: "greenhouse:ready",
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

	test("passes ready_label as --label flag", async () => {
		const repoWithLabel: RepoConfig = {
			...testRepo,
			ready_label: "greenhouse:ready",
		};

		let capturedCmd: string[] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			capturedCmd = cmd;
			return { exitCode: 0, stdout: "[]", stderr: "" };
		};

		await pollIssues(repoWithLabel, exec);

		// Verify ready_label is passed as a --label flag
		const labelIndexes = capturedCmd.reduce<number[]>((acc, v, i) => {
			if (v === "--label") acc.push(i);
			return acc;
		}, []);

		expect(labelIndexes).toHaveLength(1);
		const [idx0] = labelIndexes;
		expect(capturedCmd[Number(idx0) + 1]).toBe("greenhouse:ready");
	});

	test("throws on non-zero exit code", async () => {
		const exec = makeExec({ exitCode: 1, stdout: "", stderr: "gh: authentication required" });
		await expect(pollIssues(testRepo, exec)).rejects.toThrow("gh issue list failed");
	});
});
