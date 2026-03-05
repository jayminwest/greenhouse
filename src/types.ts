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

	// Shipping
	prUrl?: string;
	prNumber?: number;

	// Timestamps
	discoveredAt: string; // ISO 8601
	ingestedAt?: string;
	dispatchedAt?: string;
	completedAt?: string;
	shippedAt?: string;
	updatedAt: string;
}

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
		capability: string;
		max_concurrent: number;
		monitor_interval_seconds: number;
		run_timeout_minutes: number;
	};
	shipping: {
		auto_push: boolean;
		pr_template: string;
	};
}

export interface DailyBudget {
	date: string; // YYYY-MM-DD
	dispatched: number;
	cap: number;
	remaining: number;
}

export const GREENHOUSE_DIR = ".greenhouse";
export const STATE_FILE = "state.jsonl";
export const CONFIG_FILE = "config.yaml";
export const LOCK_STALE_MS = 30_000;
export const LOCK_RETRY_MS = 100;
export const LOCK_TIMEOUT_MS = 30_000;

export const DEFAULT_PR_TEMPLATE = `## Greenhouse Auto-PR

**GitHub Issue:** #{github_issue_number}
**Seeds Task:** {seeds_task_id}

### Summary
{agent_summary}

### Quality Gates
- [ ] Tests pass
- [ ] Lint clean
- [ ] Typecheck clean

---
Automated by [Greenhouse](https://github.com/jayminwest/greenhouse)`;
