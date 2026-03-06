import type { ExecFn, RepoConfig } from "./types.ts";

/**
 * Tear down the coordinator for a completed run.
 * Cleans up overstory worktrees and tmux sessions associated with the agent.
 * Best-effort: logs warning on failure but does not throw.
 */
export async function teardownCoordinator(
	agentName: string,
	repo: RepoConfig,
	exec: ExecFn,
): Promise<void> {
	await exec(["ov", "coordinator", "cleanup", agentName], {
		cwd: repo.project_root,
	}).catch(() => {});
}
