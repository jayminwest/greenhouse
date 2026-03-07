import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { defaultExec } from "./exec.ts";
import type { DaemonConfig, ExecFn, RepoConfig, RunState } from "./types.ts";
import { GREENHOUSE_DIR } from "./types.ts";

export interface ShipResult {
	prUrl: string;
	prNumber: number;
}

export interface PreflightResult {
	ok: boolean;
	failures: string[];
}

// ─── Pre-flight checks ────────────────────────────────────────────────────────

/**
 * Check for orphaned git worktrees in the project.
 * Returns an error string if orphaned worktrees are found, null if clean.
 */
async function checkNoOrphanedWorktrees(projectRoot: string, exec: ExecFn): Promise<string | null> {
	const { exitCode, stdout } = await exec(["git", "worktree", "list", "--porcelain"], {
		cwd: projectRoot,
	});
	if (exitCode !== 0) return null; // can't check — skip

	// Look for worktree entries referencing greenhouse/ branches that might be orphaned
	const lines = stdout.split("\n");
	const orphaned: string[] = [];
	let currentWorktree = "";
	let currentBranch = "";

	for (const line of lines) {
		if (line.startsWith("worktree ")) {
			currentWorktree = line.slice("worktree ".length).trim();
			currentBranch = "";
		} else if (line.startsWith("branch ")) {
			currentBranch = line.slice("branch ".length).trim();
		} else if (line === "") {
			// End of a worktree entry — check if it's a stale greenhouse worktree
			if (currentBranch.includes("refs/heads/greenhouse/") && currentWorktree !== projectRoot) {
				// This is a greenhouse worktree — check if the path actually exists
				const checkResult = await exec(["test", "-d", currentWorktree]);
				if (checkResult.exitCode !== 0) {
					orphaned.push(currentWorktree);
				}
			}
			currentWorktree = "";
			currentBranch = "";
		}
	}

	if (orphaned.length > 0) {
		return `Orphaned worktrees found: ${orphaned.join(", ")}. Run \`git worktree prune\` to clean up.`;
	}
	return null;
}

/**
 * Check for stale .lock files in the .greenhouse directory.
 * Returns an error string if stale locks are found, null if clean.
 */
async function checkNoStaleLocks(projectRoot: string): Promise<string | null> {
	const ghDir = join(projectRoot, GREENHOUSE_DIR);
	let entries: string[];
	try {
		const dirEntries = await readdir(ghDir);
		entries = dirEntries;
	} catch {
		return null; // directory doesn't exist yet — skip
	}

	const lockFiles = entries.filter((e) => e.endsWith(".lock"));
	if (lockFiles.length > 0) {
		return `Stale lock files found in .greenhouse/: ${lockFiles.join(", ")}`;
	}
	return null;
}

/**
 * Run quality gates (bun test, bun run lint, bun run typecheck) in the project root.
 * Returns a list of failure messages (empty if all pass).
 */
async function runQualityGates(projectRoot: string, exec: ExecFn): Promise<string[]> {
	const failures: string[] = [];

	const gates: Array<{ cmd: string[]; label: string }> = [
		{ cmd: ["bun", "test"], label: "bun test" },
		{ cmd: ["bun", "run", "lint"], label: "bun run lint" },
		{ cmd: ["bun", "run", "typecheck"], label: "bun run typecheck" },
	];

	for (const gate of gates) {
		const { exitCode, stderr } = await exec(gate.cmd, { cwd: projectRoot });
		if (exitCode !== 0) {
			failures.push(`${gate.label} failed: ${stderr.trim().slice(0, 200)}`);
		}
	}

	return failures;
}

/**
 * Run all pre-flight checks before shipping.
 * Returns a PreflightResult indicating pass/fail with failure details.
 */
export async function runPreflight(
	projectRoot: string,
	exec: ExecFn = defaultExec,
): Promise<PreflightResult> {
	const failures: string[] = [];

	// (1) No orphaned worktrees
	const orphanError = await checkNoOrphanedWorktrees(projectRoot, exec);
	if (orphanError) failures.push(orphanError);

	// (5) No stale .lock files (checked early — cheap)
	const lockError = await checkNoStaleLocks(projectRoot);
	if (lockError) failures.push(lockError);

	// (2–4) Quality gates
	const gateFailures = await runQualityGates(projectRoot, exec);
	failures.push(...gateFailures);

	return { ok: failures.length === 0, failures };
}

// ─── Branch recovery ──────────────────────────────────────────────────────────

/**
 * Attempt to recover agent branches into the merge branch when the merge branch
 * is empty or appears to have no feature commits relative to main.
 *
 * Finds overstory worktree branches for the given seeds run and merges them
 * into the merge branch.
 */
export async function recoverAgentBranches(
	run: RunState,
	projectRoot: string,
	exec: ExecFn = defaultExec,
): Promise<void> {
	if (!run.mergeBranch) {
		throw new Error("Run has no merge branch — cannot recover agent branches");
	}

	// List all branches matching the overstory worker pattern for this seedsId
	const { exitCode, stdout } = await exec(
		["git", "branch", "--list", `overstory/*/${run.seedsId}*`],
		{ cwd: projectRoot },
	);

	if (exitCode !== 0) return;

	const agentBranches = stdout
		.split("\n")
		.map((l) => l.trim().replace(/^\*\s*/, ""))
		.filter(Boolean);

	if (agentBranches.length === 0) {
		throw new Error(
			`No agent branches found for ${run.seedsId}. The merge branch ${run.mergeBranch} is empty.`,
		);
	}

	// Checkout the merge branch
	await exec(["git", "checkout", run.mergeBranch], { cwd: projectRoot });

	// Merge each agent branch into the merge branch
	for (const branch of agentBranches) {
		const mergeResult = await exec(
			["git", "merge", "--no-ff", "-m", `chore: merge agent branch ${branch}`, branch],
			{ cwd: projectRoot },
		);
		if (mergeResult.exitCode !== 0) {
			throw new Error(
				`Failed to merge agent branch ${branch} into ${run.mergeBranch}: ${mergeResult.stderr.trim()}`,
			);
		}
	}
}

// ─── Shipping ─────────────────────────────────────────────────────────────────

/**
 * Extract PR number from `gh pr create` output.
 * gh pr create outputs the PR URL as the last line.
 */
function extractPrNumber(prUrl: string): number {
	const match = prUrl.match(/\/pull\/(\d+)/);
	if (!match) throw new Error(`Could not parse PR number from URL: ${prUrl}`);
	return Number.parseInt(match[1] as string, 10);
}

/**
 * Ship a completed run: push the merge branch, create a PR, and comment on the
 * original GitHub issue.
 *
 * Pre-flight checks must pass before pushing. If the merge branch has no
 * feature commits relative to main, recoverAgentBranches() is attempted.
 */
export async function shipRun(
	run: RunState,
	repoConfig: RepoConfig,
	config: DaemonConfig,
	exec: ExecFn = defaultExec,
): Promise<ShipResult> {
	const { mergeBranch, ghRepo, ghIssueId, ghTitle, seedsId } = run;

	if (!mergeBranch) {
		throw new Error(`Run ${seedsId} has no merge branch`);
	}
	if (!ghIssueId || !ghRepo) {
		throw new Error(`Run ${seedsId} missing GitHub issue info`);
	}

	const projectRoot = repoConfig.project_root;

	// --- Pre-flight checks ---
	const preflight = await runPreflight(projectRoot, exec);
	if (!preflight.ok) {
		throw new Error(
			`Pre-flight checks failed:\n${preflight.failures.map((f) => `  • ${f}`).join("\n")}`,
		);
	}

	// --- Pre-ship validation: check merge branch has commits relative to main ---
	const diffCheck = await exec(["git", "diff", "--quiet", `main...${mergeBranch}`], {
		cwd: projectRoot,
	});

	if (diffCheck.exitCode === 0) {
		// No diff — merge branch may be empty. Attempt recovery.
		await recoverAgentBranches(run, projectRoot, exec);

		// Re-check after recovery
		const afterRecovery = await exec(["git", "diff", "--quiet", `main...${mergeBranch}`], {
			cwd: projectRoot,
		});
		if (afterRecovery.exitCode === 0) {
			throw new Error(
				`Merge branch ${mergeBranch} has no commits relative to main even after recovery.`,
			);
		}
	}

	// --- Push merge branch ---
	const pushResult = await exec(["git", "push", "origin", mergeBranch], { cwd: projectRoot });
	if (pushResult.exitCode !== 0) {
		throw new Error(`git push failed: ${pushResult.stderr.trim()}`);
	}

	// --- Create PR ---
	const prBody = config.shipping.pr_template.replace(
		"<!-- Summarize changes here -->",
		`Closes #${ghIssueId}\n\nSeeds task: ${seedsId}`,
	);

	const prCreateResult = await exec(
		[
			"gh",
			"pr",
			"create",
			"--repo",
			ghRepo,
			"--head",
			mergeBranch,
			"--base",
			"main",
			"--title",
			ghTitle,
			"--body",
			prBody,
		],
		{ cwd: projectRoot },
	);

	if (prCreateResult.exitCode !== 0) {
		throw new Error(`gh pr create failed: ${prCreateResult.stderr.trim()}`);
	}

	const prUrl = prCreateResult.stdout.trim();
	const prNumber = extractPrNumber(prUrl);

	// --- Comment on original GitHub issue ---
	await exec(
		[
			"gh",
			"issue",
			"comment",
			String(ghIssueId),
			"--repo",
			ghRepo,
			"--body",
			`Greenhouse has opened a pull request for this issue: ${prUrl}`,
		],
		{ cwd: projectRoot },
	);

	// --- Auto-merge if configured ---
	if (config.shipping.auto_merge) {
		await exec(
			[
				"gh",
				"pr",
				"merge",
				String(prNumber),
				"--repo",
				ghRepo,
				"--squash",
				"--auto",
				"--delete-branch",
			],
			{ cwd: projectRoot },
		);
	}

	return { prUrl, prNumber };
}

// ─── Post-ship cleanup ────────────────────────────────────────────────────────

/**
 * Restore the repository to a clean state after successfully shipping.
 * Checks out main and deletes the local merge branch.
 * Remote branch cleanup is handled by `--delete-branch` in gh pr merge, or
 * by a manual push delete if auto_merge is disabled.
 */
export async function cleanupAfterShip(
	run: RunState,
	repoConfig: RepoConfig,
	exec: ExecFn = defaultExec,
): Promise<void> {
	const projectRoot = repoConfig.project_root;
	const { mergeBranch } = run;

	// Return to main
	await exec(["git", "checkout", "main"], { cwd: projectRoot });

	if (mergeBranch) {
		// Delete local merge branch (ignore errors — branch may already be gone)
		await exec(["git", "branch", "-D", mergeBranch], { cwd: projectRoot });

		// If auto_merge is disabled, clean up the remote branch manually
		if (!run.prNumber || !repoConfig) {
			await exec(["git", "push", "origin", "--delete", mergeBranch], {
				cwd: projectRoot,
			}).catch(() => undefined);
		}
	}
}
