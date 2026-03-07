/**
 * Supervisor tmux session management for greenhouse.
 *
 * Spawns and manages a Claude Code supervisor instance in a tmux session.
 * The supervisor takes ownership of a greenhouse run after dispatch, watching
 * the overstory coordinator, shipping the PR, and cleaning up on completion.
 *
 * All subprocess calls are injectable via ExecFn for testability.
 * Session naming convention: `greenhouse-supervisor-<seedsId>`.
 */

import { join } from "node:path";
import { defaultExec } from "./exec.ts";
import type { ExecFn, SpawnSupervisorResult, SupervisorConfig } from "./types.ts";
import { GREENHOUSE_DIR } from "./types.ts";

/** Default Claude model for the supervisor. Sonnet for cost efficiency. */
const SUPERVISOR_MODEL = "claude-sonnet-4-6";

/** Grace period between SIGTERM and SIGKILL when killing the supervisor. */
const KILL_GRACE_PERIOD_MS = 2000;

/**
 * Generate the tmux session name for a supervisor run.
 *
 * @param seedsId - Seeds task ID (e.g., "greenhouse-a426")
 * @returns Tmux session name
 */
export function supervisorSessionName(seedsId: string): string {
	return `greenhouse-supervisor-${seedsId}`;
}

/**
 * Return the canonical path to the dispatch spec file for a run.
 *
 * The spec file is written by the dispatcher at
 * `<projectRoot>/.greenhouse/<seedsId>-spec.md` and contains the full run
 * context (GitHub issue number, owner, repo, labels, issue body). The
 * supervisor reads this file to obtain values not passed in the beacon.
 *
 * @param seedsId - Seeds task ID
 * @param projectRoot - Absolute path to the repo root
 * @returns Absolute path to the spec file
 */
export function supervisorSpecPath(seedsId: string, projectRoot: string): string {
	return join(projectRoot, GREENHOUSE_DIR, `${seedsId}-spec.md`);
}

/**
 * Build the Claude Code startup command for the supervisor.
 *
 * Uses `--append-system-prompt "$(cat '<specPath>')"` to inject the dispatch
 * spec at shell expansion time, avoiding tmux IPC message size limits.
 *
 * @param cfg - Supervisor configuration
 * @returns Claude CLI command string (not yet wrapped in bash)
 */
export function buildSupervisorCommand(cfg: SupervisorConfig): string {
	let cmd = `claude --model ${SUPERVISOR_MODEL} --permission-mode bypassPermissions`;

	if (cfg.specPath) {
		// Escape single quotes in the path for safe shell embedding.
		// The $(cat ...) expands inside the tmux pane's shell, so the tmux IPC
		// message only carries the short command string — not the full spec content.
		const escaped = cfg.specPath.replace(/'/g, "'\\''");
		cmd += ` --append-system-prompt "$(cat '${escaped}')"`;
	}

	return cmd;
}

/**
 * Build the initial beacon message sent to the supervisor via tmux send-keys.
 *
 * This activates the supervisor after TUI readiness is detected. The beacon
 * carries the complete run context so the supervisor can operate without
 * unresolved template variables — all key/value pairs are pre-substituted
 * before the message is sent.
 *
 * Fields included:
 * - task        — seeds task ID
 * - branch      — greenhouse merge branch
 * - repo        — "owner/repo" string
 * - project     — absolute path to the repo root (= supervisor cwd)
 * - spec        — path to the dispatch spec file (contains GitHub issue number)
 * - timeout     — run timeout in minutes
 *
 * @param cfg - Supervisor configuration
 * @returns Single-line beacon string (newlines not allowed — tmux send-keys)
 */
export function buildSupervisorBeacon(cfg: SupervisorConfig): string {
	const timestamp = new Date().toISOString();
	const timeoutMin = cfg.config.dispatch.run_timeout_minutes;
	const specPath = supervisorSpecPath(cfg.seedsId, cfg.repo.project_root);
	const parts = [
		`[GREENHOUSE SUPERVISOR] ${timestamp}`,
		`task:${cfg.seedsId}`,
		`branch:${cfg.mergeBranch}`,
		`repo:${cfg.repo.owner}/${cfg.repo.repo}`,
		`project:${cfg.repo.project_root}`,
		`spec:${specPath}`,
		`timeout:${timeoutMin}min`,
		`Startup: read spec file for full context, sd show ${cfg.seedsId} to check state, monitor overstory run, ship PR when agents complete, then clean up`,
	];
	return parts.join(" | ");
}

/**
 * Spawn a Claude Code supervisor instance in a tmux session.
 *
 * Lifecycle:
 * 1. Build env setup (unset nesting guards, export agent identity vars)
 * 2. Build claude CLI command (with --append-system-prompt-file if specPath provided)
 * 3. Wrap startup script in /bin/bash -c for shell-agnostic execution
 * 4. Create detached tmux session at repo project_root
 * 5. Retrieve pane PID
 * 6. Wait for Claude Code TUI to become ready
 * 7. Send startup beacon via tmux send-keys
 *
 * @param cfg - Supervisor configuration (seeds ID, merge branch, repo, config)
 * @param exec - Injectable subprocess executor (defaults to Bun.spawn-based)
 * @returns Session name and pane PID
 * @throws Error if tmux session creation fails or session dies during startup
 */
export async function spawnSupervisor(
	cfg: SupervisorConfig,
	exec: ExecFn = defaultExec,
): Promise<SpawnSupervisorResult> {
	const sessionName = supervisorSessionName(cfg.seedsId);
	const cwd = cfg.repo.project_root;
	const agentName = `greenhouse-supervisor-${cfg.seedsId}`;

	// Build environment setup: clear Claude Code nesting guards so the supervisor
	// can launch without being blocked by the parent claude session's env vars.
	const envParts = [
		"unset CLAUDECODE CLAUDE_CODE_SSE_PORT CLAUDE_CODE_ENTRYPOINT",
		`export OVERSTORY_AGENT_NAME="${agentName}"`,
		`export OVERSTORY_WORKTREE_PATH="${cwd}"`,
	];

	const claudeCmd = buildSupervisorCommand(cfg);
	const startupScript = `${envParts.join(" && ")} && ${claudeCmd}`;

	// Wrap in /bin/bash -c so bash syntax (export/unset, $(cat ...)) works
	// regardless of the user's default $SHELL (e.g. fish rejects bash syntax).
	// Single-quote the script and escape embedded single quotes.
	const wrappedCommand = `/bin/bash -c '${startupScript.replace(/'/g, "'\\''")}'`;

	// Create the detached tmux session
	const createResult = await exec(
		["tmux", "new-session", "-d", "-s", sessionName, "-c", cwd, wrappedCommand],
		{ cwd },
	);

	if (createResult.exitCode !== 0) {
		throw new Error(
			`Failed to create supervisor tmux session "${sessionName}": ${createResult.stderr.trim()}`,
		);
	}

	// Retrieve the pane PID so the daemon can track the process
	const pidResult = await exec(["tmux", "list-panes", "-t", sessionName, "-F", "#{pane_pid}"], {
		cwd,
	});

	if (pidResult.exitCode !== 0) {
		throw new Error(
			`Created supervisor session "${sessionName}" but failed to retrieve PID: ${pidResult.stderr.trim()}`,
		);
	}

	const pidStr = pidResult.stdout.trim().split("\n")[0] ?? "";
	if (pidStr.length === 0) {
		throw new Error(`Created supervisor session "${sessionName}" but pane PID output was empty`);
	}

	const pid = Number.parseInt(pidStr, 10);
	if (Number.isNaN(pid)) {
		throw new Error(
			`Created supervisor session "${sessionName}" but pane PID is not a number: ${pidStr}`,
		);
	}

	// Wait for Claude Code TUI to render before sending input
	await waitForSupervisorReady(sessionName, exec);

	// Send the startup beacon to activate the supervisor
	const beacon = buildSupervisorBeacon(cfg);
	await sendToSupervisor(sessionName, beacon, exec);

	return { sessionName, pid };
}

/**
 * Wait for the Claude Code TUI to become ready in a supervisor tmux session.
 *
 * Polls pane content via `tmux capture-pane`. Detection phases:
 * - "trust this folder" dialog → send Enter to dismiss, continue polling
 * - Prompt indicator (❯ or 'Try "') AND status bar ("bypass permissions"
 *   or "shift+tab") both present → ready
 * - Session dead → throw
 * - Timeout → return (session may still be starting; beacon send will follow)
 *
 * @param sessionName - Tmux session to poll
 * @param exec - Subprocess executor
 * @param timeoutMs - Max wait time (default 30s)
 * @param pollIntervalMs - Polling interval (default 500ms)
 */
async function waitForSupervisorReady(
	sessionName: string,
	exec: ExecFn,
	timeoutMs = 30_000,
	pollIntervalMs = 500,
): Promise<void> {
	const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs);
	let dialogHandled = false;

	for (let i = 0; i < maxAttempts; i++) {
		const captureResult = await exec([
			"tmux",
			"capture-pane",
			"-t",
			sessionName,
			"-p",
			"-S",
			"-50",
		]);

		if (captureResult.exitCode === 0) {
			const content = captureResult.stdout;

			// Trust dialog takes precedence — dismiss with Enter and continue
			if (content.includes("trust this folder") && !dialogHandled) {
				await exec(["tmux", "send-keys", "-t", sessionName, "", "Enter"]);
				dialogHandled = true;
				await Bun.sleep(pollIntervalMs);
				continue;
			}

			// Ready: prompt indicator + status bar both visible
			const hasPrompt = content.includes("\u276f") || content.includes('Try "');
			const hasStatusBar = content.includes("bypass permissions") || content.includes("shift+tab");

			if (hasPrompt && hasStatusBar) {
				return;
			}
		}

		// Verify the session is still alive before sleeping
		const aliveResult = await exec(["tmux", "has-session", "-t", sessionName]);
		if (aliveResult.exitCode !== 0) {
			throw new Error(`Supervisor session "${sessionName}" died during startup`);
		}

		await Bun.sleep(pollIntervalMs);
	}
	// Timeout — proceed anyway; the beacon send will follow regardless
}

/**
 * Check if a supervisor's tmux session is still alive.
 *
 * Uses `tmux has-session` — exit code 0 means the session exists.
 *
 * @param sessionName - Tmux session name to check
 * @param exec - Injectable subprocess executor
 * @returns true if the session is alive, false otherwise
 */
export async function isSupervisorAlive(
	sessionName: string,
	exec: ExecFn = defaultExec,
): Promise<boolean> {
	const result = await exec(["tmux", "has-session", "-t", sessionName]);
	return result.exitCode === 0;
}

/**
 * Send a message to a supervisor's tmux session via send-keys.
 *
 * Newlines are flattened to spaces — multiline input via send-keys causes
 * Claude Code's TUI to receive embedded Enter keystrokes which interfere
 * with message submission.
 *
 * @param sessionName - Tmux session to send to
 * @param message - Text to send (newlines will be flattened)
 * @param exec - Injectable subprocess executor
 * @throws Error if the session does not exist or send fails
 */
export async function sendToSupervisor(
	sessionName: string,
	message: string,
	exec: ExecFn = defaultExec,
): Promise<void> {
	// Flatten newlines to avoid embedded Enter keystrokes in Claude Code's TUI
	const flatMessage = message.replace(/\n/g, " ");

	const result = await exec(["tmux", "send-keys", "-t", sessionName, flatMessage, "Enter"]);

	if (result.exitCode !== 0) {
		throw new Error(
			`Failed to send keys to supervisor session "${sessionName}": ${result.stderr.trim()}`,
		);
	}
}

/**
 * Kill a supervisor's tmux session with process tree cleanup.
 *
 * Follows the SIGTERM/grace/SIGKILL pattern from overstory's tmux.ts:
 * 1. Get the pane PID via `tmux display-message`
 * 2. Walk descendant PIDs via `pgrep -P`
 * 3. SIGTERM all descendants (deepest-first), then root
 * 4. Wait grace period for processes to clean up
 * 5. SIGKILL any survivors
 * 6. Kill the tmux session itself
 *
 * @param sessionName - Tmux session name to kill
 * @param exec - Injectable subprocess executor
 * @param gracePeriodMs - Time between SIGTERM and SIGKILL (default 2000ms)
 * @throws Error if the tmux session cannot be killed (process cleanup failures
 *         are silently handled since the goal is best-effort cleanup)
 */
export async function killSupervisor(
	sessionName: string,
	exec: ExecFn = defaultExec,
	gracePeriodMs = KILL_GRACE_PERIOD_MS,
): Promise<void> {
	// Get pane PID before killing the session
	const panePidResult = await exec([
		"tmux",
		"display-message",
		"-p",
		"-t",
		sessionName,
		"#{pane_pid}",
	]);

	if (panePidResult.exitCode === 0) {
		const pidStr = panePidResult.stdout.trim();
		const panePid = Number.parseInt(pidStr, 10);

		if (!Number.isNaN(panePid)) {
			await killProcessTree(panePid, exec, gracePeriodMs);
		}
	}

	// Kill the tmux session itself
	const killResult = await exec(["tmux", "kill-session", "-t", sessionName]);

	if (killResult.exitCode !== 0) {
		const stderr = killResult.stderr;
		// Already gone is acceptable — goal is that session no longer exists
		if (stderr.includes("session not found") || stderr.includes("can't find session")) {
			return;
		}
		throw new Error(`Failed to kill supervisor session "${sessionName}": ${stderr.trim()}`);
	}
}

/**
 * Recursively collect all descendant PIDs of a process.
 *
 * Uses `pgrep -P <pid>` to find direct children, then recurses. Returns PIDs
 * in depth-first order (deepest descendants first), which is the correct order
 * for sending signals — kill children before parents to prevent reparenting.
 *
 * @param pid - Root process PID to walk from
 * @param exec - Subprocess executor
 * @returns Array of descendant PIDs, deepest-first
 */
async function getDescendantPids(pid: number, exec: ExecFn): Promise<number[]> {
	const result = await exec(["pgrep", "-P", String(pid)]);

	// pgrep exits 1 when no children found — not an error
	if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
		return [];
	}

	const childPids: number[] = [];
	for (const line of result.stdout.trim().split("\n")) {
		const childPid = Number.parseInt(line.trim(), 10);
		if (!Number.isNaN(childPid)) {
			childPids.push(childPid);
		}
	}

	// Recurse to get grandchildren (depth-first: deepest first)
	const allDescendants: number[] = [];
	for (const childPid of childPids) {
		const grandchildren = await getDescendantPids(childPid, exec);
		allDescendants.push(...grandchildren);
	}
	allDescendants.push(...childPids);

	return allDescendants;
}

/**
 * Send a signal to a process, silently ignoring errors for already-dead or
 * inaccessible processes.
 */
function sendSignal(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
	try {
		process.kill(pid, signal);
	} catch {
		// Process already dead (ESRCH), permission denied (EPERM), or invalid PID — all OK
	}
}

/**
 * Kill a process tree: SIGTERM deepest-first, wait grace period, SIGKILL survivors.
 */
async function killProcessTree(
	rootPid: number,
	exec: ExecFn,
	gracePeriodMs: number,
): Promise<void> {
	const descendants = await getDescendantPids(rootPid, exec);

	if (descendants.length === 0) {
		sendSignal(rootPid, "SIGTERM");
		return;
	}

	// Phase 1: SIGTERM all (deepest-first, then root)
	for (const pid of descendants) {
		sendSignal(pid, "SIGTERM");
	}
	sendSignal(rootPid, "SIGTERM");

	// Phase 2: Grace period for cleanup
	await Bun.sleep(gracePeriodMs);

	// Phase 3: SIGKILL survivors
	for (const pid of descendants) {
		try {
			process.kill(pid, 0); // check alive
			sendSignal(pid, "SIGKILL");
		} catch {
			// Already dead
		}
	}
	try {
		process.kill(rootPid, 0);
		sendSignal(rootPid, "SIGKILL");
	} catch {
		// Already dead
	}
}
