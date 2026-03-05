import { defaultExec } from "./exec.ts";
import type { ExecFn, RepoConfig, SlingResult } from "./types.ts";

export interface DispatchResult {
	agentName: string;
	branch: string;
	taskId: string;
	pid: number;
}

/**
 * Dispatch an overstory lead agent for a seeds task.
 * Returns agent metadata from `ov sling --json`.
 */
export async function dispatchRun(
	seedsId: string,
	repo: RepoConfig,
	exec: ExecFn = defaultExec,
): Promise<DispatchResult> {
	const { exitCode, stdout, stderr } = await exec(
		["ov", "sling", seedsId, "--capability", "lead", "--json"],
		{ cwd: repo.project_root },
	);

	if (exitCode !== 0) {
		throw new Error(`ov sling failed: ${stderr.trim()}`);
	}

	const result = JSON.parse(stdout) as SlingResult;

	return {
		agentName: result.agentName,
		branch: result.branch,
		taskId: result.taskId,
		pid: result.pid,
	};
}
