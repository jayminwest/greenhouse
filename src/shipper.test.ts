import { describe, expect, test } from "bun:test";
import { cleanupAfterShip, shipRun } from "./shipper.ts";
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
			// git diff --quiet: non-zero exit = branch has commits ahead of main
			if (cmd[0] === "git" && cmd[1] === "diff") return { exitCode: 1, stdout: "", stderr: "" };
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
			if (cmd[0] === "git" && cmd[1] === "diff") return { exitCode: 1, stdout: "", stderr: "" };
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
			if (cmd[0] === "git" && cmd[1] === "diff") return { exitCode: 1, stdout: "", stderr: "" };
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
		const exec = async (_cmd: string[]): Promise<ExecResult> => ({
			exitCode: 1,
			stdout: "",
			stderr: "",
		});
		const run = makeRun({ branch: undefined, mergeBranch: undefined });
		await expect(shipRun(run, testRepo, testConfig, exec)).rejects.toThrow("no branch to push");
	});

	test("throws when git push fails", async () => {
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git" && cmd[1] === "diff") return { exitCode: 1, stdout: "", stderr: "" };
			if (cmd[0] === "git") return { exitCode: 1, stdout: "", stderr: "push rejected" };
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		await expect(shipRun(makeRun(), testRepo, testConfig, exec)).rejects.toThrow("git push failed");
	});

	test("throws when gh pr create fails", async () => {
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git" && cmd[1] === "diff") return { exitCode: 1, stdout: "", stderr: "" };
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
			if (cmd[0] === "git" && cmd[1] === "diff") return { exitCode: 1, stdout: "", stderr: "" };
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

	test("throws when merge branch has no commits ahead of main", async () => {
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			// git diff --quiet exits 0 when there are NO differences
			if (cmd[0] === "git" && cmd[1] === "diff") return { exitCode: 0, stdout: "", stderr: "" };
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		await expect(shipRun(makeRun(), testRepo, testConfig, exec)).rejects.toThrow(
			"no commits ahead of main",
		);
	});

	test("runs gh pr merge --auto --squash when auto_merge is enabled", async () => {
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			if (cmd[0] === "git" && cmd[1] === "diff") return { exitCode: 1, stdout: "", stderr: "" };
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			if (cmd.includes("pr") && cmd.includes("create"))
				return { exitCode: 0, stdout: "https://github.com/test/pull/55\n", stderr: "" };
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		const configWithAutoMerge: DaemonConfig = {
			...testConfig,
			shipping: { ...testConfig.shipping, auto_merge: true },
		};

		await shipRun(makeRun(), testRepo, configWithAutoMerge, exec);

		const mergeCall = calls.find((c) => c.includes("merge") && c.includes("--auto"));
		expect(mergeCall).toBeDefined();
		expect(mergeCall).toContain("--squash");
		expect(mergeCall).toContain("55");
	});

	test("does NOT run gh pr merge when auto_merge is not set", async () => {
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			if (cmd[0] === "git" && cmd[1] === "diff") return { exitCode: 1, stdout: "", stderr: "" };
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			if (cmd.includes("pr") && cmd.includes("create"))
				return { exitCode: 0, stdout: "https://github.com/test/pull/55\n", stderr: "" };
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await shipRun(makeRun(), testRepo, testConfig, exec);

		const mergeCall = calls.find((c) => c.includes("merge") && c.includes("--auto"));
		expect(mergeCall).toBeUndefined();
	});
});

describe("cleanupAfterShip", () => {
	test("runs all cleanup steps in order", async () => {
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await cleanupAfterShip(makeRun(), testRepo, exec);

		expect(calls[0]).toEqual(["git", "checkout", "main"]);
		expect(calls[1]).toEqual(["git", "branch", "-D", "greenhouse/overstory-a1b2"]);
		expect(calls[2]).toEqual(["git", "pull", "origin", "main"]);
		expect(calls[3]).toEqual(["ov", "worktree", "clean", "--completed"]);
		// spec file removal
		expect(calls[4]?.[0]).toBe("rm");
		expect(calls[4]?.join(" ")).toContain("overstory-a1b2-spec.md");
	});

	test("uses mergeBranch when set", async () => {
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await cleanupAfterShip(makeRun({ mergeBranch: "greenhouse/overstory-a1b2" }), testRepo, exec);

		const deleteBranch = calls.find((c) => c[1] === "branch" && c[2] === "-D");
		expect(deleteBranch).toContain("greenhouse/overstory-a1b2");
	});

	test("falls back to greenhouse/<seedsId> when mergeBranch is not set", async () => {
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await cleanupAfterShip(makeRun({ mergeBranch: undefined }), testRepo, exec);

		const deleteBranch = calls.find((c) => c[1] === "branch" && c[2] === "-D");
		expect(deleteBranch).toContain("greenhouse/overstory-a1b2");
	});

	test("continues if one step throws", async () => {
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			// Simulate git checkout failing
			if (cmd[1] === "checkout") throw new Error("detached HEAD");
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		// Should not throw
		await expect(cleanupAfterShip(makeRun(), testRepo, exec)).resolves.toBeUndefined();
		// Remaining steps still ran
		const cmds = calls.map((c) => c.slice(0, 3).join(" "));
		expect(cmds).toContain("git branch -D");
		expect(cmds).toContain("git pull origin");
		expect(cmds).toContain("ov worktree clean");
	});

	test("continues if one step returns non-zero exit code", async () => {
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			// git branch -D fails (branch already deleted)
			if (cmd[1] === "branch") return { exitCode: 1, stdout: "", stderr: "branch not found" };
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await expect(cleanupAfterShip(makeRun(), testRepo, exec)).resolves.toBeUndefined();
		// All 5 steps still ran
		expect(calls).toHaveLength(5);
	});
});
