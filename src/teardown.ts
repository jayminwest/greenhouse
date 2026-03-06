import type { ExecFn, RepoConfig } from "./types.ts";

/**
 * Tear down the coordinator for a completed run.
 * Stops the overstory coordinator process so it does not continue picking up work unsupervised.
 * Best-effort: logs warning on failure but does not throw.
 */
export async function teardownCoordinator(
	_agentName: string,
	repo: RepoConfig,
	exec: ExecFn,
): Promise<void> {
	await exec(["ov", "coordinator", "stop"], {
		cwd: repo.project_root,
	}).catch(() => {});
}
