import { defaultExec } from "./exec.ts";
import type { DaemonConfig, ExecFn, RepoConfig, RunState, ShipResult } from "./types.ts";

const DEFAULT_PR_TEMPLATE = `## Greenhouse Auto-PR

**GitHub Issue:** #{github_issue_number}
**Seeds Task:** {seeds_task_id}

### Summary
Automated by Greenhouse.

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
	const prNumber = prNumberMatch ? Number.parseInt(prNumberMatch[1], 10) : 0;

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
