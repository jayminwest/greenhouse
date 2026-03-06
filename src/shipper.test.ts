import { describe, expect, test } from "bun:test";
import { shipRun } from "./shipper.ts";
import type { DaemonConfig, ExecResult, RepoConfig, RunState } from "./types.ts";

const testRepo: RepoConfig = {
	owner: "jayminwest",
	repo: "overstory",
	labels: ["agent-ready"],
	project_root: "/tmp/test-repo",
};

const testConfig: DaemonConfig = {
	version: "1",
	repos: [testRepo],
	poll_interval_minutes: 10,
	daily_cap: 5,
	dispatch: {
		capability: "lead",
		max_concurrent: 2,
		monitor_interval_seconds: 30,
		run_timeout_minutes: 60,
	},
	shipping: {
		auto_push: true,
		pr_template: "",
	},
};

function makeRun(overrides?: Partial<RunState>): RunState {
	const now = new Date().toISOString();
	return {
		ghIssueId: 42,
		ghRepo: "jayminwest/overstory",
		ghTitle: "Fix retry logic",
		ghLabels: ["agent-ready"],
		seedsId: "overstory-a1b2",
		status: "shipping",
		branch: "overstory/lead-42/overstory-a1b2",
		mergeBranch: "greenhouse/overstory-a1b2",
		discoveredAt: now,
		updatedAt: now,
		...overrides,
	};
}

describe("shipRun", () => {
	test("pushes mergeBranch and creates PR, returns prUrl and prNumber", async () => {
		const prUrl = "https://github.com/jayminwest/overstory/pull/99";

		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			// git push returns empty
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			// gh pr create prints URL to stdout
			if (cmd.includes("pr")) return { exitCode: 0, stdout: `${prUrl}\n`, stderr: "" };
			// gh issue comment
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		const result = await shipRun(makeRun(), testRepo, testConfig, exec);

		expect(result.prUrl).toBe(prUrl);
		expect(result.prNumber).toBe(99);
	});

	test("uses mergeBranch for git push and PR --head", async () => {
		let pushCmd: string[] = [];
		let prCmd: string[] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git") {
				pushCmd = cmd;
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (cmd.includes("pr")) {
				prCmd = cmd;
				return {
					exitCode: 0,
					stdout: "https://github.com/test/pull/1\n",
					stderr: "",
				};
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await shipRun(makeRun(), testRepo, testConfig, exec);

		// git push should use mergeBranch
		expect(pushCmd).toContain("greenhouse/overstory-a1b2");

		// PR --head should use mergeBranch
		const headIdx = prCmd.indexOf("--head");
		expect(prCmd[headIdx + 1]).toBe("greenhouse/overstory-a1b2");
	});

	test("falls back to agent branch when mergeBranch is not set", async () => {
		let pushCmd: string[] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git") {
				pushCmd = cmd;
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (cmd.includes("pr")) {
				return {
					exitCode: 0,
					stdout: "https://github.com/test/pull/1\n",
					stderr: "",
				};
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await shipRun(makeRun({ mergeBranch: undefined }), testRepo, testConfig, exec);

		// Should fall back to agent branch
		expect(pushCmd).toContain("overstory/lead-42/overstory-a1b2");
	});

	test("throws when run has no branch", async () => {
		const exec = async (): Promise<ExecResult> => ({ exitCode: 0, stdout: "", stderr: "" });
		const run = makeRun({ branch: undefined, mergeBranch: undefined });
		await expect(shipRun(run, testRepo, testConfig, exec)).rejects.toThrow("no branch to push");
	});

	test("throws when git push fails", async () => {
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git") return { exitCode: 1, stdout: "", stderr: "push rejected" };
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		await expect(shipRun(makeRun(), testRepo, testConfig, exec)).rejects.toThrow("git push failed");
	});

	test("throws when gh pr create fails", async () => {
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "PR already exists" };
		};
		await expect(shipRun(makeRun(), testRepo, testConfig, exec)).rejects.toThrow(
			"gh pr create failed",
		);
	});

	test("passes correct repo to gh pr create", async () => {
		let prCmd: string[] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			if (cmd.includes("pr")) {
				prCmd = cmd;
				return {
					exitCode: 0,
					stdout: "https://github.com/test/pull/1\n",
					stderr: "",
				};
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await shipRun(makeRun(), testRepo, testConfig, exec);

		expect(prCmd).toContain("--repo");
		const repoIdx = prCmd.indexOf("--repo");
		expect(prCmd[repoIdx + 1]).toBe("jayminwest/overstory");
	});
});
