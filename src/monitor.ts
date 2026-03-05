import { defaultExec } from "./exec.ts";
import type { ExecFn, RepoConfig, StatusResult } from "./types.ts";

export interface MonitorResult {
	completed: boolean;
	state: string;
}

/**
 * Check the status of an overstory run by polling `ov status --json`.
 * An agent is considered complete when its state is "completed" or "zombie".
 * If the agent is not found (already cleaned up), treat as completed.
 */
export async function checkRunStatus(
	taskId: string,
	repo: RepoConfig,
	exec: ExecFn = defaultExec,
): Promise<MonitorResult> {
	const { exitCode, stdout, stderr } = await exec(["ov", "status", "--json"], {
		cwd: repo.project_root,
	});

	if (exitCode !== 0) {
		throw new Error(`ov status failed: ${stderr.trim()}`);
	}

	const result = JSON.parse(stdout) as StatusResult;
	const agent = result.agents.find((a) => a.taskId === taskId);

	// Agent not found means it's been cleaned up — treat as completed
	if (!agent) {
		return { completed: true, state: "completed" };
	}

	const completed = agent.state === "completed" || agent.state === "zombie";
	return { completed, state: agent.state };
}
