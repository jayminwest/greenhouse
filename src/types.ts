/**
 * Shared types and interfaces for greenhouse.
 */

export type RunStatus = "pending" | "ingested" | "running" | "shipping" | "shipped" | "failed";

export interface RunState {
	// GitHub source
	ghIssueId: number;
	ghRepo: string;
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
	discoveredAt: string;
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
	date: string;
	dispatched: number;
	cap: number;
	remaining: number;
}
