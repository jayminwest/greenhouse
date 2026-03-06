import { describe, expect, test } from "bun:test";
import { cleanupAfterShip, recoverAgentBranches, shipRun } from "./shipper.ts";
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
		expect(mergeCall).toContain("--delete-branch");
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

describe("recoverAgentBranches", () => {
	test("returns 0 when no agent branches exist", async () => {
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		const result = await recoverAgentBranches(
			"overstory-a1b2",
			"greenhouse/overstory-a1b2",
			"/tmp",
			exec,
		);
		expect(result).toBe(0);
		// Only the branch --list command should run (no checkout or merge)
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual(["git", "branch", "--list", "overstory/*/greenhouse-overstory-a1b2"]);
	});

	test("checks out merge branch and merges each agent branch", async () => {
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			if (cmd.includes("--list"))
				return {
					exitCode: 0,
					stdout:
						"  overstory/lead-1/greenhouse-overstory-a1b2\n  overstory/lead-2/greenhouse-overstory-a1b2\n",
					stderr: "",
				};
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		const result = await recoverAgentBranches(
			"overstory-a1b2",
			"greenhouse/overstory-a1b2",
			"/tmp",
			exec,
		);
		expect(result).toBe(2);

		// checkout merge branch
		expect(calls[1]).toEqual(["git", "checkout", "greenhouse/overstory-a1b2"]);
		// merge first agent branch
		expect(calls[2]).toContain("overstory/lead-1/greenhouse-overstory-a1b2");
		// merge second agent branch
		expect(calls[3]).toContain("overstory/lead-2/greenhouse-overstory-a1b2");
	});

	test("aborts failed merge and counts only successful merges", async () => {
		const calls: string[][] = [];
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			if (cmd.includes("--list"))
				return {
					exitCode: 0,
					stdout:
						"  overstory/lead-1/greenhouse-overstory-a1b2\n  overstory/lead-2/greenhouse-overstory-a1b2\n",
					stderr: "",
				};
			// First merge fails
			if (cmd[1] === "merge" && cmd.some((s) => s.includes("lead-1")))
				return { exitCode: 1, stdout: "", stderr: "conflict" };
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		const result = await recoverAgentBranches(
			"overstory-a1b2",
			"greenhouse/overstory-a1b2",
			"/tmp",
			exec,
		);
		expect(result).toBe(1);

		// merge --abort should have been called after the failed merge
		const abortCall = calls.find((c) => c[1] === "merge" && c[2] === "--abort");
		expect(abortCall).toBeDefined();
	});
});

describe("shipRun recovery", () => {
	test("merges agent branches when merge branch is empty, then ships", async () => {
		const calls: string[][] = [];
		let diffCallCount = 0;

		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			calls.push(cmd);
			if (cmd[0] === "git" && cmd[1] === "diff") {
				diffCallCount++;
				// First check: empty (0). Second check (after recovery): non-empty (1).
				return { exitCode: diffCallCount === 1 ? 0 : 1, stdout: "", stderr: "" };
			}
			if (cmd.includes("--list"))
				return {
					exitCode: 0,
					stdout: "  overstory/lead-1/greenhouse-overstory-a1b2\n",
					stderr: "",
				};
			if (cmd[0] === "git") return { exitCode: 0, stdout: "", stderr: "" };
			if (cmd.includes("pr") && cmd.includes("create"))
				return {
					exitCode: 0,
					stdout: "https://github.com/jayminwest/overstory/pull/10\n",
					stderr: "",
				};
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		const result = await shipRun(makeRun(), testRepo, testConfig, exec);
		expect(result.prNumber).toBe(10);

		// Should have merged the agent branch
		const mergeCall = calls.find(
			(c) => c[1] === "merge" && c.includes("overstory/lead-1/greenhouse-overstory-a1b2"),
		);
		expect(mergeCall).toBeDefined();
	});

	test("throws when merge branch still empty after recovery", async () => {
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			// All diffs return 0 (no difference)
			if (cmd[0] === "git" && cmd[1] === "diff") return { exitCode: 0, stdout: "", stderr: "" };
			// No agent branches
			if (cmd.includes("--list")) return { exitCode: 0, stdout: "", stderr: "" };
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await expect(shipRun(makeRun(), testRepo, testConfig, exec)).rejects.toThrow(
			"no commits ahead of main",
		);
	});

	test("still throws when agent branches exist but all merges fail and branch remains empty", async () => {
		const exec = async (cmd: string[], _opts?: { cwd?: string }): Promise<ExecResult> => {
			if (cmd[0] === "git" && cmd[1] === "diff") {
				return { exitCode: 0, stdout: "", stderr: "" }; // always empty
			}
			if (cmd.includes("--list"))
				return {
					exitCode: 0,
					stdout: "  overstory/lead-1/greenhouse-overstory-a1b2\n",
					stderr: "",
				};
			// All merges fail
			if (cmd[1] === "merge" && !cmd.includes("--abort"))
				return { exitCode: 1, stdout: "", stderr: "conflict" };
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await expect(shipRun(makeRun(), testRepo, testConfig, exec)).rejects.toThrow(
			"no commits ahead of main",
		);
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
		expect(calls[2]).toEqual(["git", "push", "origin", "--delete", "greenhouse/overstory-a1b2"]);
		expect(calls[3]).toEqual(["git", "pull", "origin", "main"]);
		expect(calls[4]).toEqual(["ov", "worktree", "clean", "--completed"]);
		// spec file removal
		expect(calls[5]?.[0]).toBe("rm");
		expect(calls[5]?.join(" ")).toContain("overstory-a1b2-spec.md");
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
		// All 6 steps still ran (local delete + remote delete + pull + worktree clean + spec rm)
		expect(calls).toHaveLength(6);
	});
});
