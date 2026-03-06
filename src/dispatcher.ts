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
