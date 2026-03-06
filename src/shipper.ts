import { defaultExec } from "./exec.ts";
import type { DaemonConfig, ExecFn, RepoConfig, RunState, ShipResult } from "./types.ts";

const DEFAULT_PR_TEMPLATE = `## Greenhouse Auto-PR

Closes #{github_issue_number}

**Seeds Task:** {seeds_task_id}

### Summary
{agent_summary}

### Quality Gates
- [ ] Tests pass
- [ ] Lint clean
- [ ] Typecheck clean

---
Automated by [Greenhouse](https://github.com/jayminwest/greenhouse)`;

function renderPrBody(run: RunState, config: DaemonConfig): string {
	const template = config.shipping.pr_template || DEFAULT_PR_TEMPLATE;
	return template
		.replace("{github_issue_number}", String(run.ghIssueId))
		.replace("#{github_issue_number}", `#${run.ghIssueId}`)
		.replace("{seeds_task_id}", run.seedsId)
		.replace("{agent_summary}", `Seeds task: ${run.seedsId}`);
}

/**
 * If the greenhouse merge branch is empty (no commits ahead of main), attempt to
 * recover by merging any local overstory agent branches that match the seeds ID.
 * Returns the number of branches successfully merged.
 */
export async function recoverAgentBranches(
	seedsId: string,
	branch: string,
	projectRoot: string,
	exec: ExecFn,
): Promise<number> {
	const { stdout: branchListOut } = await exec(
		["git", "branch", "--list", `overstory/*/greenhouse-${seedsId}`],
		{ cwd: projectRoot },
	);

	const agentBranches = branchListOut
		.split("\n")
		.map((b) => b.trim().replace(/^\*\s*/, ""))
		.filter(Boolean);

	if (agentBranches.length === 0) return 0;

	// Ensure we're on the greenhouse merge branch before merging
	await exec(["git", "checkout", branch], { cwd: projectRoot });

	let merged = 0;
	for (const agentBranch of agentBranches) {
		const { exitCode: mergeCode } = await exec(
			["git", "merge", "--no-ff", agentBranch, "-m", `chore: recover agent branch ${agentBranch}`],
			{ cwd: projectRoot },
		);
		if (mergeCode !== 0) {
			// Abort failed merge and continue with remaining branches
			await exec(["git", "merge", "--abort"], { cwd: projectRoot });
		} else {
			merged++;
		}
	}
	return merged;
}

/**
 * Push the greenhouse merge branch and create a GitHub PR.
 * Uses mergeBranch (greenhouse-controlled) instead of the agent's worktree branch,
 * since overstory may have already cleaned up the worktree branch.
 * Returns PR URL and number.
 */
export async function shipRun(
	run: RunState,
	repo: RepoConfig,
	config: DaemonConfig,
	exec: ExecFn = defaultExec,
): Promise<ShipResult> {
	// Prefer mergeBranch (greenhouse-controlled), fall back to agent branch for backwards compat
	const branch = run.mergeBranch ?? run.branch;
	if (!branch) {
		throw new Error(`Run ${run.seedsId} has no branch to push`);
	}

	// Pre-ship validation (phase 1): check if merge branch already has commits ahead of main
	const { exitCode: initialDiffCode } = await exec(["git", "diff", "--quiet", `main...${branch}`], {
		cwd: repo.project_root,
	});
	let diffCode = initialDiffCode;

	// Recovery: if merge branch is empty, attempt to merge matching agent branches
	if (diffCode === 0) {
		const recovered = await recoverAgentBranches(run.seedsId, branch, repo.project_root, exec);
		if (recovered > 0) {
			// Re-check diff after recovery
			const { exitCode: recheckCode } = await exec(["git", "diff", "--quiet", `main...${branch}`], {
				cwd: repo.project_root,
			});
			diffCode = recheckCode;
		}
	}

	// Pre-ship validation (phase 2): fail if still empty after recovery
	if (diffCode === 0) {
		throw new Error(`Merge branch has no commits ahead of main — agent work was not merged`);
	}

	// Push the branch
	const { exitCode: pushCode, stderr: pushErr } = await exec(["git", "push", "origin", branch], {
		cwd: repo.project_root,
	});

	if (pushCode !== 0) {
		throw new Error(`git push failed: ${pushErr.trim()}`);
	}

	// Build PR title: "fix: <gh title> (#<issue>)"
	const prTitle = `${run.ghTitle} (#${run.ghIssueId})`;
	const prBody = renderPrBody(run, config);

	// Create the PR — gh pr create prints the PR URL to stdout
	const {
		exitCode: prCode,
		stdout: prOut,
		stderr: prErr,
	} = await exec(
		[
			"gh",
			"pr",
			"create",
			"--repo",
			`${repo.owner}/${repo.repo}`,
			"--head",
			branch,
			"--base",
			"main",
			"--title",
			prTitle,
			"--body",
			prBody,
		],
		{ cwd: repo.project_root },
	);

	if (prCode !== 0) {
		throw new Error(`gh pr create failed: ${prErr.trim()}`);
	}

	// gh pr create prints the URL to stdout, extract PR number from it
	const prUrl = prOut.trim();
	const prNumberMatch = prUrl.match(/\/pull\/(\d+)$/);
	const prNumber = prNumberMatch?.[1] ? Number.parseInt(prNumberMatch[1], 10) : 0;

	// Auto-merge if configured
	if (config.shipping.auto_merge) {
		await exec(
			[
				"gh",
				"pr",
				"merge",
				String(prNumber),
				"--repo",
				`${repo.owner}/${repo.repo}`,
				"--auto",
				"--squash",
				"--delete-branch",
			],
			{ cwd: repo.project_root },
		);
	}

	// Comment on the GitHub issue with the PR link
	await exec(
		[
			"gh",
			"issue",
			"comment",
			String(run.ghIssueId),
			"--repo",
			`${repo.owner}/${repo.repo}`,
			"--body",
			`Greenhouse opened PR #${prNumber} for this issue. Review and merge when ready.`,
		],
		{ cwd: repo.project_root },
	);

	return { prUrl, prNumber };
}

/**
 * Restore the repo to a clean state after a PR is shipped.
 * All steps are best-effort — a failure in one step does not block subsequent steps.
 */
export async function cleanupAfterShip(
	run: RunState,
	repo: RepoConfig,
	exec: ExecFn = defaultExec,
): Promise<void> {
	const { project_root } = repo;

	// 1. git checkout main
	try {
		await exec(["git", "checkout", "main"], { cwd: project_root });
	} catch (_) {
		/* non-fatal */
	}

	// 2. Delete local merge branch
	const branchToDelete = run.mergeBranch ?? `greenhouse/${run.seedsId}`;
	try {
		await exec(["git", "branch", "-D", branchToDelete], { cwd: project_root });
	} catch (_) {
		/* non-fatal */
	}

	// 2b. Delete remote merge branch (best-effort)
	try {
		await exec(["git", "push", "origin", "--delete", branchToDelete], { cwd: project_root });
	} catch (_) {
		/* non-fatal */
	}

	// 3. git pull origin main
	try {
		await exec(["git", "pull", "origin", "main"], { cwd: project_root });
	} catch (_) {
		/* non-fatal */
	}

	// 4. Clean up overstory worktrees
	try {
		await exec(["ov", "worktree", "clean", "--completed"], { cwd: project_root });
	} catch (_) {
		/* non-fatal */
	}

	// 5. Remove spec file
	try {
		await exec(["rm", "-f", `${project_root}/.greenhouse/${run.seedsId}-spec.md`], {
			cwd: project_root,
		});
	} catch (_) {
		/* non-fatal */
	}
}
