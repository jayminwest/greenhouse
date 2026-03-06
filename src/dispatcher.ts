import { join } from "node:path";
import { defaultExec } from "./exec.ts";
import type { DispatchContext, ExecFn, RepoConfig, SlingResult } from "./types.ts";
import { GREENHOUSE_DIR } from "./types.ts";

export interface DispatchResult {
	agentName: string;
	branch: string;
	mergeBranch: string;
	taskId: string;
	pid: number;
}

export interface DispatchOptions {
	capability?: string;
	context?: DispatchContext;
}

/**
 * Build the structured dispatch message body for the coordinator.
 * This is the contract between greenhouse and the coordinator agent.
 */
export function buildDispatchMessage(
	seedsId: string,
	mergeBranch: string,
	context: DispatchContext,
): string {
	const labelLines =
		context.ghLabels && context.ghLabels.length > 0
			? context.ghLabels.map((l) => `- ${l}`).join("\n")
			: "- (none)";

	const issueBody = context.ghIssueBody?.trim() ?? "(no description provided)";

	return `# Greenhouse Dispatch: ${seedsId}

## Task

- **Seeds ID:** ${seedsId}
- **Title:** ${context.seedsTitle}
- **GitHub Issue:** #${context.ghIssueNumber} in ${context.ghRepo}

## Labels

${labelLines}

## Issue Description

${issueBody}

## Base Branch

All work must be merged into: \`${mergeBranch}\`

## Instructions

You are a coordinator agent dispatched by Greenhouse to implement a GitHub issue.

1. **Decompose** the task into work streams and spawn lead agents.
2. **Coordinate** lead agents to implement the changes.
3. **Merge** all agent branches into the base branch (\`${mergeBranch}\`) when complete.
4. **Close** the seeds issue when done: \`sd close ${seedsId} --reason "..."\`
5. **Clean up** all worktrees used by agents when finished.

The base branch \`${mergeBranch}\` is greenhouse's merge target. All work must land here before greenhouse can ship the PR.
`;
}

/**
 * Create a greenhouse-controlled merge branch for the run.
 * Overstory agents will branch off this, and their work will be
 * merged back into it before shipping as a PR.
 */
async function createMergeBranch(seedsId: string, repo: RepoConfig, exec: ExecFn): Promise<string> {
	const mergeBranch = `greenhouse/${seedsId}`;

	const { exitCode, stderr } = await exec(["git", "branch", mergeBranch, "HEAD"], {
		cwd: repo.project_root,
	});

	if (exitCode !== 0) {
		throw new Error(`Failed to create merge branch ${mergeBranch}: ${stderr.trim()}`);
	}

	return mergeBranch;
}

/**
 * Write dispatch message spec to .greenhouse/<seedsId>-spec.md and return path.
 */
async function writeSpecFile(
	seedsId: string,
	content: string,
	projectRoot: string,
): Promise<string> {
	const specPath = join(projectRoot, GREENHOUSE_DIR, `${seedsId}-spec.md`);
	await Bun.write(specPath, content);
	return specPath;
}

/**
 * Dispatch an overstory coordinator agent for a seeds task.
 * Creates a greenhouse merge branch first, then dispatches via `ov sling`.
 * Returns agent metadata including the merge branch for shipping.
 *
 * @param options.capability - Agent capability to dispatch (default: "coordinator")
 * @param options.context    - Issue context for structured dispatch message
 */
export async function dispatchRun(
	seedsId: string,
	repo: RepoConfig,
	exec: ExecFn = defaultExec,
	options: DispatchOptions = {},
): Promise<DispatchResult> {
	const capability = options.capability ?? "coordinator";

	// Create greenhouse-controlled merge branch before dispatching
	const mergeBranch = await createMergeBranch(seedsId, repo, exec);

	const slingArgs = [
		"ov",
		"sling",
		seedsId,
		"--capability",
		capability,
		"--base-branch",
		mergeBranch,
		"--json",
	];

	// If issue context is provided, write a structured spec file for the coordinator
	if (options.context) {
		const message = buildDispatchMessage(seedsId, mergeBranch, options.context);
		const specPath = await writeSpecFile(seedsId, message, repo.project_root);
		slingArgs.push("--spec", specPath);
	}

	const { exitCode, stdout, stderr } = await exec(slingArgs, { cwd: repo.project_root });

	if (exitCode !== 0) {
		throw new Error(`ov sling failed: ${stderr.trim()}`);
	}

	const result = JSON.parse(stdout) as SlingResult;

	return {
		agentName: result.agentName,
		branch: result.branch,
		mergeBranch,
		taskId: result.taskId,
		pid: result.pid,
	};
}
