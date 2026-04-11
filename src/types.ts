// === GitHub Types ===

export interface GhLabel {
	name: string;
}

export interface GhIssue {
	number: number;
	title: string;
	body: string;
	labels: GhLabel[];
	assignees: Array<{ login: string }>;
}

// === Run State ===

export type RunStatus = "pending" | "ingested" | "running" | "shipping" | "shipped" | "failed";

export interface RunState {
	// GitHub source
	ghIssueId: number;
	ghRepo: string; // "owner/repo"
	ghTitle: string;
	ghLabels: string[];

	// Seeds mapping
	seedsId: string;

	// Lifecycle
	status: RunStatus;
	error?: string;
	retryable?: boolean;

	// Overstory
	agentName?: string;
	branch?: string;
	mergeBranch?: string;

	// Shipping
	prUrl?: string;
	prNumber?: number;

	// Timestamps
	discoveredAt: string;
	ingestedAt?: string;
	dispatchedAt?: string;
	completedAt?: string;
	shippedAt?: string;
	updatedAt: string;
}

// v0.2.0 fresh-clone run record (new architecture)
export interface RunRecord {
	ghRepo: string;
	ghIssue: number;
	ghTitle: string;
	cloneDir: string;
	seedsId?: string;
	status: "pending" | "ingested" | "running" | "shipped" | "failed";
	prUrl?: string;
	prNumber?: number;
	discoveredAt: string;
	error?: string;
}

// === Config Types ===

export interface RepoConfig {
	owner: string;
	repo: string;
	labels: string[];
	project_root: string;
}

export interface DaemonConfig {
	version: string;
	repos: RepoConfig[];
	poll_interval_minutes: number;
	daily_cap: number;
	dispatch: {
		run_timeout_minutes: number;
	};
}

export interface CloneContext {
	repoConfig: RepoConfig;
	cloneDir: string;
}

// === Subprocess Abstraction ===

export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type ExecFn = (cmd: string[], opts?: { cwd?: string }) => Promise<ExecResult>;

// === ov coordinator start --json response ===

export interface CoordinatorStartResult {
	success: boolean;
	command: string;
	agentName: string;
	capability: string;
	tmuxSession: string;
	projectRoot: string;
	pid: number;
	watchdog: boolean;
	monitor: boolean;
}

// === ov coordinator send --json response ===

export interface CoordinatorSendResult {
	success: boolean;
	command: string;
	id: string;
	nudged: boolean;
}

// === sd create --json response ===

export interface SdCreateResult {
	success: boolean;
	command: string;
	id: string;
}

// === ov coordinator status --json response ===

export interface CoordinatorStatus {
	success: boolean;
	command: string;
	running: boolean;
	sessionId?: string;
	state?: string;
	tmuxSession?: string;
	pid?: number;
	startedAt?: string;
	lastActivity?: string;
	watchdogRunning: boolean;
	monitorRunning: boolean;
}

// === Constants ===

export const GREENHOUSE_DIR = ".greenhouse";
export const CONFIG_FILE = "config.yaml";

// === Dispatch ===

export interface DispatchContext {
	seedsTitle: string;
	ghIssueNumber: number;
	ghRepo: string; // "owner/repo"
	ghIssueBody?: string;
	ghLabels?: string[];
}
