import type { ExecFn, RepoConfig } from "./types.ts";

/**
 * Tear down the coordinator for a completed run.
 * Stops the overstory coordinator and cleans up any orphaned sub-agent tmux sessions.
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

	// Defensively clean up any orphaned overstory sub-agent tmux sessions.
	// 'ov coordinator stop' should kill its children but may leave sessions behind on crash.
	const listResult = await exec(["tmux", "list-sessions", "-F", "#{session_name}"], {
		cwd: repo.project_root,
	}).catch(() => null);

	if (!listResult || listResult.exitCode !== 0) return;

	const sessions = listResult.stdout
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s.startsWith("overstory-"));

	await Promise.all(
		sessions.map((session) =>
			exec(["tmux", "kill-session", "-t", session], { cwd: repo.project_root }).catch(() => {}),
		),
	);
}
