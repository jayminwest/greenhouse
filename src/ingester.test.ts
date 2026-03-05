import { describe, expect, test } from "bun:test";
import { ingestIssue, mapLabels } from "./ingester.ts";
import type { ExecResult, GhIssue, RepoConfig } from "./types.ts";

const testRepo: RepoConfig = {
	owner: "jayminwest",
	repo: "overstory",
	labels: ["agent-ready"],
	project_root: "/tmp/test-repo",
};

function makeIssue(overrides?: Partial<GhIssue>): GhIssue {
	return {
		number: 42,
		title: "Fix the thing",
		body: "Body text here.",
		labels: [{ name: "agent-ready" }],
		assignees: [],
		...overrides,
	};
}

function makeExec(result: ExecResult) {
	return async (_cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => result;
}

describe("mapLabels", () => {
	test("defaults: no labels -> task, priority 2", () => {
		const result = mapLabels([]);
		expect(result.type).toBe("task");
		expect(result.priority).toBe(2);
		expect(result.areaPrefix).toBe("");
		expect(result.difficultySuffix).toBe("");
	});

	test("type:bug -> bug", () => {
		const result = mapLabels(["type:bug"]);
		expect(result.type).toBe("bug");
	});

	test("type:feature -> feature", () => {
		const result = mapLabels(["type:feature"]);
		expect(result.type).toBe("feature");
	});

	test("priority:P1 -> priority 1", () => {
		const result = mapLabels(["priority:P1"]);
		expect(result.priority).toBe(1);
	});

	test("priority:P0 -> priority 0 (critical)", () => {
		const result = mapLabels(["priority:P0"]);
		expect(result.priority).toBe(0);
	});

	test("area:mail -> [mail] prefix", () => {
		const result = mapLabels(["area:mail"]);
		expect(result.areaPrefix).toBe("[mail] ");
	});

	test("difficulty:hard -> (hard) suffix", () => {
		const result = mapLabels(["difficulty:hard"]);
		expect(result.difficultySuffix).toBe(" (hard)");
	});

	test("combined labels", () => {
		const result = mapLabels(["type:bug", "priority:P1", "area:mail", "difficulty:hard"]);
		expect(result.type).toBe("bug");
		expect(result.priority).toBe(1);
		expect(result.areaPrefix).toBe("[mail] ");
		expect(result.difficultySuffix).toBe(" (hard)");
	});
});

describe("ingestIssue", () => {
	test("calls sd create with correct args and returns seedsId", async () => {
		const sdResponse = JSON.stringify({ success: true, command: "create", id: "overstory-a1b2" });
		const exec = makeExec({ exitCode: 0, stdout: sdResponse, stderr: "" });

		const result = await ingestIssue(makeIssue(), testRepo, exec);
		expect(result.seedsId).toBe("overstory-a1b2");
	});

	test("applies label mapping to sd create command", async () => {
		let capturedCmd: string[] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			capturedCmd = cmd;
			return {
				exitCode: 0,
				stdout: JSON.stringify({ success: true, command: "create", id: "x-1234" }),
				stderr: "",
			};
		};

		const issue = makeIssue({
			labels: [{ name: "type:bug" }, { name: "priority:P0" }],
		});

		await ingestIssue(issue, testRepo, exec);

		const typeIdx = capturedCmd.indexOf("--type");
		const priIdx = capturedCmd.indexOf("--priority");
		expect(capturedCmd[typeIdx + 1]).toBe("bug");
		expect(capturedCmd[priIdx + 1]).toBe("0");
	});

	test("uses repo project_root as cwd", async () => {
		let capturedCwd: string | undefined;
		const exec = async (_cmd: string[], opts?: { cwd?: string }): Promise<ExecResult> => {
			capturedCwd = opts?.cwd;
			return {
				exitCode: 0,
				stdout: JSON.stringify({ success: true, command: "create", id: "x-0000" }),
				stderr: "",
			};
		};

		await ingestIssue(makeIssue(), testRepo, exec);
		expect(capturedCwd).toBe(testRepo.project_root);
	});

	test("throws on sd create failure", async () => {
		const exec = makeExec({ exitCode: 1, stdout: "", stderr: "sd: lock conflict" });
		await expect(ingestIssue(makeIssue(), testRepo, exec)).rejects.toThrow("sd create failed");
	});
});
