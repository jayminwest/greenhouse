import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ExecFn, RepoConfig } from "./types.ts";

/**
 * Tear down the coordinator for a completed run.
 * Cleans up overstory worktrees and tmux sessions associated with the agent.
 * Removes session-branch.txt and returns to main branch.
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

	// Remove session-branch.txt so ov merge no longer has a fixed target
	const sessionBranchPath = join(repo.project_root, ".overstory", "session-branch.txt");
	await unlink(sessionBranchPath).catch(() => {});

	// Return to main branch
	await exec(["git", "checkout", "main"], {
		cwd: repo.project_root,
	}).catch(() => {});
}
