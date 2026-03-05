import { defaultExec } from "./exec.ts";
import type { ExecFn, GhIssue, RepoConfig } from "./types.ts";

/**
 * Fetch open GitHub issues from a repo filtered by the configured labels.
 * Uses `gh issue list --json` for structured output.
 */
export async function pollIssues(repo: RepoConfig, exec: ExecFn = defaultExec): Promise<GhIssue[]> {
	const cmd = [
		"gh",
		"issue",
		"list",
		"--repo",
		`${repo.owner}/${repo.repo}`,
		"--state",
		"open",
		"--json",
		"number,title,body,labels,assignees",
		"--limit",
		"20",
	];

	// Add one --label flag per label (gh filters issues matching ALL labels)
	for (const label of repo.labels) {
		cmd.push("--label", label);
	}

	const { exitCode, stdout, stderr } = await exec(cmd);

	if (exitCode !== 0) {
		throw new Error(`gh issue list failed: ${stderr.trim()}`);
	}

	const issues = JSON.parse(stdout) as GhIssue[];
	return issues;
}
