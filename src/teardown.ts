import { defaultExec } from "./exec.ts";
import type { ExecFn, RepoConfig } from "./types.ts";

/**
 * Attempt to clean up overstory resources for a run whose coordinator has died.
 * Best-effort: errors are swallowed since the coordinator may already be gone.
 */
export async function teardownDeadRun(
	taskId: string,
	repo: RepoConfig,
	exec: ExecFn = defaultExec,
): Promise<void> {
	await exec(["ov", "coordinator", "cleanup", taskId], {
		cwd: repo.project_root,
	}).catch(() => {});
}
