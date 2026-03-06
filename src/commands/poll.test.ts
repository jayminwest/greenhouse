/**
 * Tests for grhs poll --dry-run
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecFn } from "../types.ts";
import { runDryPoll } from "./poll.ts";

const TEST_DIR = join(import.meta.dir, "__test_poll__");

function makeConfig(projectRoot: string) {
	return {
		version: "1",
		repos: [
			{
				owner: "testorg",
				repo: "testrepo",
				labels: ["status:triaged"],
				project_root: projectRoot,
			},
		],
		poll_interval_minutes: 10,
		daily_cap: 5,
		dispatch: {
			capability: "lead",
			max_concurrent: 2,
			monitor_interval_seconds: 30,
			run_timeout_minutes: 60,
		},
		shipping: {
			auto_push: true,
			pr_template: "",
		},
	};
}

function makeIssues(issues: Array<{ number: number; title: string; labels: string[] }>): ExecFn {
	return async () => ({
		exitCode: 0,
		stdout: JSON.stringify(
			issues.map((i) => ({
				number: i.number,
				title: i.title,
				body: "",
				labels: i.labels.map((name) => ({ name })),
				assignees: [],
			})),
		),
		stderr: "",
	});
}

describe("runDryPoll", () => {
	beforeEach(() => {
		mkdirSync(join(TEST_DIR, ".greenhouse"), { recursive: true });
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("returns issues with correct fields for new issues", async () => {
		const exec = makeIssues([
			{ number: 1, title: "Fix bug", labels: ["status:triaged", "type:bug"] },
		]);
		const config = makeConfig(TEST_DIR);
		const results = await runDryPoll(config, exec);

		expect(results).toHaveLength(1);
		const repo = results[0];
		expect(repo?.repo).toBe("testorg/testrepo");
		expect(repo?.error).toBeUndefined();
		expect(repo?.issues).toHaveLength(1);

		const issue = repo?.issues[0];
		expect(issue?.number).toBe(1);
		expect(issue?.title).toBe("Fix bug");
		expect(issue?.labels).toEqual(["status:triaged", "type:bug"]);
		expect(issue?.alreadyIngested).toBe(false);
	});

	it("marks already-ingested issues correctly", async () => {
		// Write state for issue #42
		const stateEntry = JSON.stringify({
			ghIssueId: 42,
			ghRepo: "testorg/testrepo",
			ghTitle: "Old issue",
			ghLabels: [],
			seedsId: "greenhouse-1",
			status: "shipped",
			discoveredAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
		writeFileSync(join(TEST_DIR, ".greenhouse", "state.jsonl"), `${stateEntry}\n`);

		const exec = makeIssues([
			{ number: 42, title: "Old issue", labels: ["status:triaged"] },
			{ number: 99, title: "New issue", labels: ["status:triaged"] },
		]);
		const config = makeConfig(TEST_DIR);
		const results = await runDryPoll(config, exec);

		const issues = results[0]?.issues ?? [];
		const issue42 = issues.find((i) => i.number === 42);
		const issue99 = issues.find((i) => i.number === 99);

		expect(issue42?.alreadyIngested).toBe(true);
		expect(issue99?.alreadyIngested).toBe(false);
	});

	it("returns error field and empty issues when poll fails", async () => {
		const exec: ExecFn = async () => ({
			exitCode: 1,
			stdout: "",
			stderr: "gh: not authenticated",
		});
		const config = makeConfig(TEST_DIR);
		const results = await runDryPoll(config, exec);

		expect(results).toHaveLength(1);
		const repo = results[0];
		expect(repo?.issues).toHaveLength(0);
		expect(repo?.error).toContain("gh issue list failed");
	});

	it("returns empty issues array when no issues found", async () => {
		const exec = makeIssues([]);
		const config = makeConfig(TEST_DIR);
		const results = await runDryPoll(config, exec);

		expect(results[0]?.issues).toHaveLength(0);
		expect(results[0]?.error).toBeUndefined();
	});

	it("returns results for multiple repos", async () => {
		const exec = makeIssues([{ number: 1, title: "Issue A", labels: [] }]);
		const config = {
			...makeConfig(TEST_DIR),
			repos: [
				{ owner: "org", repo: "repo1", labels: [], project_root: TEST_DIR },
				{ owner: "org", repo: "repo2", labels: [], project_root: TEST_DIR },
			],
		};
		const results = await runDryPoll(config, exec);

		expect(results).toHaveLength(2);
		expect(results[0]?.repo).toBe("org/repo1");
		expect(results[1]?.repo).toBe("org/repo2");
	});

	it("does not write any state during dry run", async () => {
		const exec = makeIssues([{ number: 5, title: "Test issue", labels: ["bug"] }]);
		const config = makeConfig(TEST_DIR);
		await runDryPoll(config, exec);

		// state.jsonl should not exist (was never created)
		const stateExists = await Bun.file(join(TEST_DIR, ".greenhouse", "state.jsonl")).exists();
		expect(stateExists).toBe(false);
	});
});
