import { defaultExec } from "./exec.ts";
import type { ExecFn, RepoConfig, RunState } from "./types.ts";

/**
 * Clean up local state after a run fails and notify the GitHub issue.
 * All steps are best-effort — a failure in one step does not block subsequent steps.
 * Preserves remote branch for forensics; only deletes local branch.
 */
export async function cleanupAfterFailure(
	run: RunState,
	repo: RepoConfig,
	error: string,
	retryable: boolean,
	exec: ExecFn = defaultExec,
): Promise<void> {
	const { project_root } = repo;

	// 1. git checkout main
	try {
		await exec(["git", "checkout", "main"], { cwd: project_root });
	} catch (_) {
		/* non-fatal */
	}

	// 2. Delete local merge branch (preserve remote for forensics)
	const branchToDelete = run.mergeBranch ?? `greenhouse/${run.seedsId}`;
	try {
		await exec(["git", "branch", "-D", branchToDelete], { cwd: project_root });
	} catch (_) {
		/* non-fatal */
	}

	// 3. Clean up overstory worktrees
	try {
		await exec(["ov", "worktree", "clean", "--completed"], { cwd: project_root });
	} catch (_) {
		/* non-fatal */
	}

	// 4. Remove spec file
	try {
		await exec(["rm", "-f", `${project_root}/.greenhouse/${run.seedsId}-spec.md`], {
			cwd: project_root,
		});
	} catch (_) {
		/* non-fatal */
	}

	// 5. Comment on GitHub issue about the failure
	const retryableLabel = retryable ? "retryable" : "terminal";
	const commentBody = `Greenhouse run failed: ${error}. Run marked as ${retryableLabel}.`;
	try {
		await exec(
			[
				"gh",
				"issue",
				"comment",
				String(run.ghIssueId),
				"--repo",
				`${repo.owner}/${repo.repo}`,
				"--body",
				commentBody,
			],
			{ cwd: project_root },
		);
	} catch (_) {
		/* non-fatal */
	}
}
