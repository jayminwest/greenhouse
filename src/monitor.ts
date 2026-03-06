import { defaultExec } from "./exec.ts";
import type { CoordinatorStatus, ExecFn, RepoConfig, SdIssue } from "./types.ts";

export interface MonitorResult {
	completed: boolean;
	state: string;
	failed?: boolean;
	retryable?: boolean;
}

/**
 * Check the status of a run by polling `sd show <seedsId> --json`.
 * A run is complete when the seeds issue status is "closed".
 * Also checks coordinator health via `ov coordinator status --json`:
 * if the coordinator is not running (state=completed, zombie, or tmux dead)
 * with the issue still open, returns completed=true with failed=true and
 * retryable=true so the daemon can reschedule.
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

	// Coordinator health check: detect if coordinator died mid-run
	const coordResult = await exec(["ov", "coordinator", "status", "--json"], {
		cwd: repo.project_root,
	});

	if (coordResult.exitCode !== 0) {
		// Coordinator command failed — coordinator is gone
		return { completed: true, state: "failed", failed: true, retryable: true };
	}

	const coordStatus = JSON.parse(coordResult.stdout) as CoordinatorStatus;
	if (!coordStatus.running) {
		// Coordinator is not running but issue still open — failed and retryable
		return { completed: true, state: "failed", failed: true, retryable: true };
	}

	return { completed: false, state: issue.status };
}
