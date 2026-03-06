import { join } from "node:path";
import { defaultExec } from "./exec.ts";
import type {
	CoordinatorSendResult,
	CoordinatorStartResult,
	CoordinatorStatus,
	DispatchContext,
	ExecFn,
	RepoConfig,
} from "./types.ts";
import { GREENHOUSE_DIR } from "./types.ts";

export interface DispatchResult {
	agentName: string;
	mergeBranch: string;
	mailId: string;
}

export interface DispatchOptions {
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
3. **Wait for ALL agents to complete.** Do NOT proceed until every lead and builder agent you spawned has finished and their work is merged.
4. **Merge** all agent branches into the base branch (\`${mergeBranch}\`). Verify the merge branch contains the feature commits — not just metadata.
5. **Clean up** all worktrees and sessions used by agents.
6. **Close** the seeds issue LAST: \`sd close ${seedsId} --reason "..."\`

**CRITICAL: The seeds issue closure is greenhouse's signal to ship a PR. Do NOT close it until:**
- All spawned agents (leads AND builders) have completed
- All agent work has been merged into \`${mergeBranch}\`
- All worktrees and sessions are cleaned up

Closing the seeds issue prematurely will cause greenhouse to ship an empty PR.

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
 * Checkout the merge branch and write .overstory/session-branch.txt so
 * `ov merge` resolves to the correct target without needing an --into flag.
 */
async function setupSessionBranch(
	mergeBranch: string,
	repo: RepoConfig,
	exec: ExecFn,
): Promise<void> {
	const { exitCode, stderr } = await exec(["git", "checkout", mergeBranch], {
		cwd: repo.project_root,
	});

	if (exitCode !== 0) {
		throw new Error(`Failed to checkout merge branch ${mergeBranch}: ${stderr.trim()}`);
	}

	const sessionBranchPath = join(repo.project_root, ".overstory", "session-branch.txt");
	await Bun.write(sessionBranchPath, mergeBranch);
}

/**
 * Ensure the coordinator is running. Checks status first; starts if not running.
 * Returns the coordinator's agent name.
 */
async function ensureCoordinator(repo: RepoConfig, exec: ExecFn): Promise<string> {
	// Check if coordinator is already running
	const statusResult = await exec(["ov", "coordinator", "status", "--json"], {
		cwd: repo.project_root,
	});

	if (statusResult.exitCode === 0) {
		const status = JSON.parse(statusResult.stdout) as CoordinatorStatus;
		if (status.running) {
			return "coordinator";
		}
	}

	// Start the coordinator
	const startResult = await exec(["ov", "coordinator", "start", "--watchdog", "--json"], {
		cwd: repo.project_root,
	});

	if (startResult.exitCode !== 0) {
		throw new Error(`ov coordinator start failed: ${startResult.stderr.trim()}`);
	}

	const result = JSON.parse(startResult.stdout) as CoordinatorStartResult;
	return result.agentName;
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
 * Dispatch work to the coordinator via `ov coordinator send`.
 * Creates a greenhouse merge branch first, then sends a dispatch message
 * to the persistent coordinator agent.
 *
 * @param options.context - Issue context for structured dispatch message
 */
export async function dispatchRun(
	seedsId: string,
	repo: RepoConfig,
	exec: ExecFn = defaultExec,
	options: DispatchOptions = {},
): Promise<DispatchResult> {
	// Create greenhouse-controlled merge branch before dispatching
	const mergeBranch = await createMergeBranch(seedsId, repo, exec);

	// Checkout merge branch and write session-branch.txt for ov merge resolution
	await setupSessionBranch(mergeBranch, repo, exec);

	// Ensure coordinator is running
	const agentName = await ensureCoordinator(repo, exec);

	// Build the dispatch message
	const context = options.context;
	const subject = context ? `Objective: ${context.seedsTitle}` : `Objective: implement ${seedsId}`;

	let body: string;
	if (context) {
		body = buildDispatchMessage(seedsId, mergeBranch, context);
		// Also write spec file for reference
		await writeSpecFile(seedsId, body, repo.project_root);
	} else {
		body = `Implement seeds task ${seedsId}. Merge all work into branch \`${mergeBranch}\`. Close the seeds issue when done: \`sd close ${seedsId}\`.`;
	}

	// Send dispatch to coordinator
	const { exitCode, stdout, stderr } = await exec(
		["ov", "coordinator", "send", "--body", body, "--subject", subject, "--json"],
		{ cwd: repo.project_root },
	);

	if (exitCode !== 0) {
		throw new Error(`ov coordinator send failed: ${stderr.trim()}`);
	}

	const result = JSON.parse(stdout) as CoordinatorSendResult;

	return {
		agentName,
		mergeBranch,
		mailId: result.id,
	};
}
