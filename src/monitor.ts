import { defaultExec } from "./exec.ts";
import type { ExecFn, OvStatusResult, RepoConfig, SdIssue } from "./types.ts";

export interface MonitorResult {
	completed: boolean;
	state: string;
	failed?: boolean;
	retryable?: boolean;
}

/**
 * Check the status of a run by polling `sd show <seedsId> --json`.
 * A run is complete when the seeds issue status is "closed".
 * Also checks agent health via `ov status --json`: if no task-specific agents
 * (lead/builder) with matching taskId are found while the issue is still open,
 * the run has failed and is retryable so the daemon can reschedule.
 * The coordinator is excluded from this check — it is long-lived and always
 * shows state=working regardless of individual task progress.
 */
export async function checkRunStatus(
	taskId: string,
	repo: RepoConfig,
	exec: ExecFn = defaultExec,
): Promise<MonitorResult> {
	// Poll seeds issue status
	const { exitCode, stdout, stderr } = await exec(["sd", "show", taskId, "--json"], {
		cwd: repo.project_root,
	});

	if (exitCode !== 0) {
		throw new Error(`sd show failed: ${stderr.trim()}`);
	}

	const parsed = JSON.parse(stdout) as { issue: SdIssue } | SdIssue;
	const issue: SdIssue = "issue" in parsed ? parsed.issue : parsed;

	if (issue.status === "closed") {
		return { completed: true, state: "closed" };
	}

	// Agent health check: detect if all task-specific agents have exited mid-run.
	// Uses ov status --json which lists all agents; filters by taskId to find
	// lead/builder agents working on this specific task. The coordinator is
	// excluded — it is long-lived and always reports state=working.
	const statusResult = await exec(["ov", "status", "--json"], {
		cwd: repo.project_root,
	});

	if (statusResult.exitCode !== 0) {
		// ov status failed — assume agents are gone
		return { completed: true, state: "failed", failed: true, retryable: true };
	}

	const ovStatus = JSON.parse(statusResult.stdout) as OvStatusResult;
	const taskAgents = ovStatus.agents.filter(
		(a) => a.taskId === taskId && a.capability !== "coordinator",
	);

	if (taskAgents.length === 0) {
		// No task-specific agents found but issue is still open — failed and retryable
		return { completed: true, state: "failed", failed: true, retryable: true };
	}

	return { completed: false, state: issue.status };
}
