import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupAfterShip, recoverAgentBranches, runPreflight, shipRun } from "./shipper.ts";
import type { DaemonConfig, ExecFn, ExecResult, RepoConfig, RunState } from "./types.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeExec(responses: Record<string, ExecResult>): ExecFn {
	return async (cmd: string[]): Promise<ExecResult> => {
		const key = cmd.join(" ");
		// Find the longest matching prefix
		for (const [pattern, result] of Object.entries(responses)) {
			if (key.startsWith(pattern)) {
				return result;
			}
		}
		// Default: success with empty output
		return { exitCode: 0, stdout: "", stderr: "" };
	};
}

function ok(stdout = ""): ExecResult {
	return { exitCode: 0, stdout, stderr: "" };
}

function fail(stderr = "error"): ExecResult {
	return { exitCode: 1, stdout: "", stderr };
}

function makeRun(overrides: Partial<RunState> = {}): RunState {
	return {
		ghIssueId: 42,
		ghRepo: "owner/repo",
		ghTitle: "Test issue",
		ghLabels: ["feature"],
		seedsId: "proj-001a",
		status: "running",
		mergeBranch: "greenhouse/proj-001a",
		discoveredAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T01:00:00.000Z",
		...overrides,
	};
}

function makeRepoConfig(projectRoot: string): RepoConfig {
	return {
		owner: "owner",
		repo: "repo",
		labels: ["feature"],
		project_root: projectRoot,
	};
}

function makeConfig(overrides: Partial<DaemonConfig["shipping"]> = {}): DaemonConfig {
	return {
		version: "1",
		repos: [],
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
			pr_template:
				"## Greenhouse Auto-PR\n\nCloses #{github_issue_number}\n\n**Seeds Task:** {seeds_task_id}\n\n### Summary\n{agent_summary}",
			...overrides,
		},
	};
}

// ─── runPreflight ─────────────────────────────────────────────────────────────

describe("runPreflight", () => {
	let projectRoot: string;

	beforeEach(async () => {
		projectRoot = await mkdtemp(join(tmpdir(), "gh-ship-test-"));
	});

	afterEach(async () => {
		await rm(projectRoot, { recursive: true, force: true });
	});

	it("returns ok when all checks pass", async () => {
		const exec = makeExec({
			"git worktree list": ok("worktree /project\nHEAD abc123\nbranch refs/heads/main\n\n"),
			"bun test": ok(),
			"bun run lint": ok(),
			"bun run typecheck": ok(),
		});

		const result = await runPreflight(projectRoot, exec);
		expect(result.ok).toBe(true);
		expect(result.failures).toHaveLength(0);
	});

	it("fails when bun test fails", async () => {
		const exec = makeExec({
			"git worktree list": ok("worktree /project\nHEAD abc123\nbranch refs/heads/main\n\n"),
			"bun test": fail("3 tests failed"),
			"bun run lint": ok(),
			"bun run typecheck": ok(),
		});

		const result = await runPreflight(projectRoot, exec);
		expect(result.ok).toBe(false);
		expect(result.failures.some((f) => f.includes("bun test"))).toBe(true);
	});

	it("fails when lint fails", async () => {
		const exec = makeExec({
			"git worktree list": ok("worktree /project\nHEAD abc123\nbranch refs/heads/main\n\n"),
			"bun test": ok(),
			"bun run lint": fail("lint error"),
			"bun run typecheck": ok(),
		});

		const result = await runPreflight(projectRoot, exec);
		expect(result.ok).toBe(false);
		expect(result.failures.some((f) => f.includes("bun run lint"))).toBe(true);
	});

	it("fails when typecheck fails", async () => {
		const exec = makeExec({
			"git worktree list": ok("worktree /project\nHEAD abc123\nbranch refs/heads/main\n\n"),
			"bun test": ok(),
			"bun run lint": ok(),
			"bun run typecheck": fail("type error"),
		});

		const result = await runPreflight(projectRoot, exec);
		expect(result.ok).toBe(false);
		expect(result.failures.some((f) => f.includes("bun run typecheck"))).toBe(true);
	});

	it("fails when stale lock files exist", async () => {
		// Create a .greenhouse dir with a lock file
		const ghDir = join(projectRoot, ".greenhouse");
		await Bun.write(join(ghDir, "state.lock"), "locked");

		const exec = makeExec({
			"git worktree list": ok("worktree /project\nHEAD abc123\nbranch refs/heads/main\n\n"),
			"bun test": ok(),
			"bun run lint": ok(),
			"bun run typecheck": ok(),
		});

		const result = await runPreflight(projectRoot, exec);
		expect(result.ok).toBe(false);
		expect(result.failures.some((f) => f.includes(".lock"))).toBe(true);
	});

	it("collects multiple failures", async () => {
		const exec = makeExec({
			"git worktree list": ok("worktree /project\nHEAD abc123\nbranch refs/heads/main\n\n"),
			"bun test": fail("tests failed"),
			"bun run lint": fail("lint failed"),
			"bun run typecheck": ok(),
		});

		const result = await runPreflight(projectRoot, exec);
		expect(result.ok).toBe(false);
		expect(result.failures.length).toBeGreaterThanOrEqual(2);
	});
});

// ─── recoverAgentBranches ─────────────────────────────────────────────────────

describe("recoverAgentBranches", () => {
	let projectRoot: string;

	beforeEach(async () => {
		projectRoot = await mkdtemp(join(tmpdir(), "gh-recover-test-"));
	});

	afterEach(async () => {
		await rm(projectRoot, { recursive: true, force: true });
	});

	it("throws if run has no merge branch", async () => {
		const run = makeRun({ mergeBranch: undefined });
		const exec = makeExec({});

		await expect(recoverAgentBranches(run, projectRoot, exec)).rejects.toThrow("no merge branch");
	});

	it("throws if no agent branches found", async () => {
		const run = makeRun();
		const exec = makeExec({
			"git branch --list": ok(""), // no matching branches
		});

		await expect(recoverAgentBranches(run, projectRoot, exec)).rejects.toThrow(
			"No agent branches found",
		);
	});

	it("merges agent branches into merge branch", async () => {
		const run = makeRun();
		const commands: string[][] = [];
		const exec: ExecFn = async (cmd) => {
			commands.push(cmd);
			if (cmd[0] === "git" && cmd[1] === "branch" && cmd[2] === "--list") {
				return ok("  overstory/builder/proj-001a\n  overstory/builder2/proj-001a\n");
			}
			return ok();
		};

		await recoverAgentBranches(run, projectRoot, exec);

		// Should have checked out merge branch
		expect(commands.some((c) => c.includes("checkout") && c.includes("greenhouse/proj-001a"))).toBe(
			true,
		);
		// Should have merged agent branches
		expect(commands.filter((c) => c.includes("merge")).length).toBe(2);
	});
});

// ─── shipRun ──────────────────────────────────────────────────────────────────

describe("shipRun", () => {
	let projectRoot: string;

	beforeEach(async () => {
		projectRoot = await mkdtemp(join(tmpdir(), "gh-ship-run-test-"));
	});

	afterEach(async () => {
		await rm(projectRoot, { recursive: true, force: true });
	});

	it("throws if run has no merge branch", async () => {
		const run = makeRun({ mergeBranch: undefined });
		const exec = makeExec({});

		await expect(shipRun(run, makeRepoConfig(projectRoot), makeConfig(), exec)).rejects.toThrow(
			"no merge branch",
		);
	});

	it("throws if pre-flight fails", async () => {
		const run = makeRun();
		const exec = makeExec({
			"git worktree list": ok("worktree /project\nHEAD abc123\nbranch refs/heads/main\n\n"),
			"bun test": fail("tests failed"),
			"bun run lint": ok(),
			"bun run typecheck": ok(),
		});

		await expect(shipRun(run, makeRepoConfig(projectRoot), makeConfig(), exec)).rejects.toThrow(
			"Pre-flight checks failed",
		);
	});

	it("pushes branch and creates PR on success", async () => {
		const run = makeRun();
		const commands: string[][] = [];
		let capturedPrBody = "";
		const exec: ExecFn = async (cmd) => {
			commands.push(cmd);
			if (cmd.join(" ").startsWith("git worktree list")) {
				return ok("worktree /project\nHEAD abc123\nbranch refs/heads/main\n\n");
			}
			if (cmd.join(" ").startsWith("bun")) return ok();
			// diff check: non-zero means there IS a diff (branch has commits)
			if (cmd.join(" ").startsWith("git diff --quiet")) {
				return fail(); // non-zero = has diff = good
			}
			if (cmd.join(" ").startsWith("git push origin greenhouse")) return ok();
			if (cmd.join(" ").startsWith("gh pr create")) {
				// Capture the --body arg
				const bodyIdx = cmd.indexOf("--body");
				if (bodyIdx !== -1 && cmd[bodyIdx + 1] !== undefined)
					capturedPrBody = cmd[bodyIdx + 1] ?? "";
				return ok("https://github.com/owner/repo/pull/99\n");
			}
			if (cmd.join(" ").startsWith("gh issue comment")) return ok();
			return ok();
		};

		const result = await shipRun(run, makeRepoConfig(projectRoot), makeConfig(), exec);
		expect(result.prUrl).toBe("https://github.com/owner/repo/pull/99");
		expect(result.prNumber).toBe(99);

		// Verify push was called
		expect(commands.some((c) => c.includes("push") && c.includes("greenhouse/proj-001a"))).toBe(
			true,
		);
		// Verify PR was created
		expect(commands.some((c) => c.includes("gh") && c.includes("pr") && c.includes("create"))).toBe(
			true,
		);
		// Verify issue was commented on
		expect(
			commands.some((c) => c.includes("gh") && c.includes("issue") && c.includes("comment")),
		).toBe(true);
		// Verify template variables were substituted
		expect(capturedPrBody).toContain("42"); // github_issue_number
		expect(capturedPrBody).toContain("proj-001a"); // seeds_task_id
		expect(capturedPrBody).not.toContain("{github_issue_number}");
		expect(capturedPrBody).not.toContain("{seeds_task_id}");
		expect(capturedPrBody).not.toContain("{agent_summary}");
	});

	it("triggers auto-merge when configured", async () => {
		const run = makeRun();
		const commands: string[][] = [];
		const exec: ExecFn = async (cmd) => {
			commands.push(cmd);
			if (cmd.join(" ").startsWith("git worktree list")) {
				return ok("worktree /project\nHEAD abc123\nbranch refs/heads/main\n\n");
			}
			if (cmd.join(" ").startsWith("bun")) return ok();
			if (cmd.join(" ").startsWith("git diff --quiet")) return fail();
			if (cmd.join(" ").startsWith("git push")) return ok();
			if (cmd.join(" ").startsWith("gh pr create")) {
				return ok("https://github.com/owner/repo/pull/7\n");
			}
			return ok();
		};

		await shipRun(run, makeRepoConfig(projectRoot), makeConfig({ auto_merge: true }), exec);

		const mergeCmd = commands.find(
			(c) => c.includes("gh") && c.includes("pr") && c.includes("merge"),
		);
		expect(mergeCmd).toBeDefined();
		expect(mergeCmd).toContain("--squash");
		expect(mergeCmd).toContain("--delete-branch");
	});

	it("does not auto-merge when auto_merge is false", async () => {
		const run = makeRun();
		const commands: string[][] = [];
		const exec: ExecFn = async (cmd) => {
			commands.push(cmd);
			if (cmd.join(" ").startsWith("git worktree list")) {
				return ok("worktree /project\nHEAD abc123\nbranch refs/heads/main\n\n");
			}
			if (cmd.join(" ").startsWith("bun")) return ok();
			if (cmd.join(" ").startsWith("git diff --quiet")) return fail();
			if (cmd.join(" ").startsWith("git push")) return ok();
			if (cmd.join(" ").startsWith("gh pr create")) {
				return ok("https://github.com/owner/repo/pull/8\n");
			}
			return ok();
		};

		await shipRun(run, makeRepoConfig(projectRoot), makeConfig({ auto_merge: false }), exec);

		const mergeCmd = commands.find(
			(c) => c.includes("gh") && c.includes("pr") && c.includes("merge"),
		);
		expect(mergeCmd).toBeUndefined();
	});

	it("fails if gh pr create fails", async () => {
		const run = makeRun();
		const exec: ExecFn = async (cmd) => {
			if (cmd.join(" ").startsWith("git worktree list")) {
				return ok("worktree /project\nHEAD abc123\nbranch refs/heads/main\n\n");
			}
			if (cmd.join(" ").startsWith("bun")) return ok();
			if (cmd.join(" ").startsWith("git diff --quiet")) return fail();
			if (cmd.join(" ").startsWith("git push")) return ok();
			if (cmd.join(" ").startsWith("gh pr create")) {
				return fail("pr already exists");
			}
			return ok();
		};

		await expect(shipRun(run, makeRepoConfig(projectRoot), makeConfig(), exec)).rejects.toThrow(
			"gh pr create failed",
		);
	});
});

// ─── cleanupAfterShip ─────────────────────────────────────────────────────────

describe("cleanupAfterShip", () => {
	let projectRoot: string;

	beforeEach(async () => {
		projectRoot = await mkdtemp(join(tmpdir(), "gh-cleanup-test-"));
	});

	afterEach(async () => {
		await rm(projectRoot, { recursive: true, force: true });
	});

	it("checks out main and deletes local merge branch", async () => {
		const run = makeRun({ prNumber: 99 });
		const commands: string[][] = [];
		const exec: ExecFn = async (cmd) => {
			commands.push(cmd);
			return ok();
		};

		await cleanupAfterShip(run, makeRepoConfig(projectRoot), exec);

		expect(commands.some((c) => c.includes("checkout") && c.includes("main"))).toBe(true);
		expect(
			commands.some(
				(c) => c.includes("branch") && c.includes("-D") && c.includes("greenhouse/proj-001a"),
			),
		).toBe(true);
	});

	it("does not crash when merge branch is undefined", async () => {
		const run = makeRun({ mergeBranch: undefined });
		const exec: ExecFn = async () => ok();
		// Should not throw
		await expect(cleanupAfterShip(run, makeRepoConfig(projectRoot), exec)).resolves.toBeUndefined();
	});

	it("throws when git checkout main fails (dirty worktree)", async () => {
		const run = makeRun({ prNumber: 99 });
		const exec: ExecFn = async (cmd) => {
			if (cmd.includes("checkout") && cmd.includes("main")) {
				return fail("error: Your local changes would be overwritten by checkout");
			}
			return ok();
		};

		await expect(cleanupAfterShip(run, makeRepoConfig(projectRoot), exec)).rejects.toThrow(
			"git checkout main failed",
		);
	});
});
