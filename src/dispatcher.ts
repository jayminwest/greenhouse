import { defaultExec } from "./exec.ts";
import type { ExecFn, RepoConfig, SlingResult } from "./types.ts";

export interface DispatchResult {
	agentName: string;
	branch: string;
	mergeBranch: string;
	taskId: string;
	pid: number;
}

/**
 * Create a greenhouse-controlled merge branch for the run.
 * Overstory agents will branch off this, and their work will be
 * merged back into it before shipping as a PR.
 */
async function createMergeBranch(seedsId: string, repo: RepoConfig, exec: ExecFn): Promise<string> {
	const mergeBranch = `greenhouse/${seedsId}`;

	const { exitCode, stderr } = await exec(["git", "branch", mergeBranch, "HEAD"], {
		cwd: repo.project_root,
	});

	if (exitCode !== 0) {
		throw new Error(`Failed to create merge branch ${mergeBranch}: ${stderr.trim()}`);
	}

	return mergeBranch;
}

/**
 * Dispatch an overstory lead agent for a seeds task.
 * Creates a greenhouse merge branch first, then dispatches via `ov sling`.
 * Returns agent metadata including the merge branch for shipping.
 */
export async function dispatchRun(
	seedsId: string,
	repo: RepoConfig,
	exec: ExecFn = defaultExec,
): Promise<DispatchResult> {
	// Create greenhouse-controlled merge branch before dispatching
	const mergeBranch = await createMergeBranch(seedsId, repo, exec);

	const { exitCode, stdout, stderr } = await exec(
		["ov", "sling", seedsId, "--capability", "lead", "--base-branch", mergeBranch, "--json"],
		{ cwd: repo.project_root },
	);

	if (exitCode !== 0) {
		throw new Error(`ov sling failed: ${stderr.trim()}`);
	}

	const result = JSON.parse(stdout) as SlingResult;

	return {
		agentName: result.agentName,
		branch: result.branch,
		mergeBranch,
		taskId: result.taskId,
		pid: result.pid,
	};
}
