import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, parseYaml } from "./config.ts";

const TMP = join(import.meta.dir, ".test-config-tmp");

beforeEach(() => {
	mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
});

function writeConfig(name: string, content: string): string {
	const path = join(TMP, name);
	writeFileSync(path, content);
	return path;
}

// ─── parseYaml ────────────────────────────────────────────────────────────────

describe("parseYaml", () => {
	test("parses flat key-value pairs", () => {
		const result = parseYaml(`version: "1"\npoll_interval_minutes: 10\ndaily_cap: 5\n`);
		expect(result.version).toBe("1");
		expect(result.poll_interval_minutes).toBe(10);
		expect(result.daily_cap).toBe(5);
	});

	test("parses nested objects", () => {
		const result = parseYaml("dispatch:\n  capability: lead\n  max_concurrent: 2\n");
		expect(result.dispatch).toEqual({ capability: "lead", max_concurrent: 2 });
	});

	test("parses string arrays", () => {
		const result = parseYaml("labels:\n  - agent-ready\n  - bug\n");
		expect(result.labels).toEqual(["agent-ready", "bug"]);
	});

	test("parses object arrays", () => {
		const yaml =
			"repos:\n  - owner: jayminwest\n    repo: overstory\n    labels:\n      - agent-ready\n    project_root: /path/to/repo\n";
		const result = parseYaml(yaml);
		const repos = result.repos as Array<Record<string, unknown>>;
		expect(repos).toHaveLength(1);
		expect(repos[0]?.owner).toBe("jayminwest");
		expect(repos[0]?.repo).toBe("overstory");
		expect(repos[0]?.labels).toEqual(["agent-ready"]);
		expect(repos[0]?.project_root).toBe("/path/to/repo");
	});

	test("parses block scalar |", () => {
		const yaml = "pr_template: |\n  ## Auto PR\n  Hello\n";
		const result = parseYaml(yaml);
		expect(result.pr_template).toBe("## Auto PR\nHello\n");
	});

	test("parses booleans", () => {
		const result = parseYaml("auto_push: true\ndry_run: false\n");
		expect(result.auto_push).toBe(true);
		expect(result.dry_run).toBe(false);
	});

	test("ignores comments", () => {
		const result = parseYaml(`# this is a comment\nversion: "1" # inline comment\n`);
		expect(result.version).toBe("1");
		expect(Object.keys(result)).toHaveLength(1);
	});
});

// ─── loadConfig ───────────────────────────────────────────────────────────────

const MINIMAL_CONFIG = `version: "1"
repos:
  - owner: jayminwest
    repo: overstory
    labels:
      - agent-ready
    project_root: /path/to/overstory
`;

describe("loadConfig", () => {
	test("loads minimal config with defaults", async () => {
		const path = writeConfig("config.yaml", MINIMAL_CONFIG);
		const config = await loadConfig(path);
		expect(config.version).toBe("1");
		expect(config.repos).toHaveLength(1);
		expect(config.repos[0]?.owner).toBe("jayminwest");
		expect(config.repos[0]?.repo).toBe("overstory");
		expect(config.repos[0]?.labels).toEqual(["agent-ready"]);
		// Defaults
		expect(config.poll_interval_minutes).toBe(10);
		expect(config.daily_cap).toBe(5);
		expect(config.dispatch.capability).toBe("coordinator");
		expect(config.dispatch.max_concurrent).toBe(2);
		expect(config.dispatch.monitor_interval_seconds).toBe(30);
		expect(config.dispatch.run_timeout_minutes).toBe(90);
		expect(config.shipping.auto_push).toBe(true);
		expect(typeof config.shipping.pr_template).toBe("string");
		expect(config.shipping.pr_template.length).toBeGreaterThan(0);
	});

	test("overrides defaults with provided values", async () => {
		const content = `${MINIMAL_CONFIG}poll_interval_minutes: 15\ndaily_cap: 10\ndispatch:\n  capability: specialist\n  max_concurrent: 4\n  monitor_interval_seconds: 60\n  run_timeout_minutes: 120\nshipping:\n  auto_push: false\n`;
		const path = writeConfig("config.yaml", content);
		const config = await loadConfig(path);
		expect(config.poll_interval_minutes).toBe(15);
		expect(config.daily_cap).toBe(10);
		expect(config.dispatch.capability).toBe("specialist");
		expect(config.dispatch.max_concurrent).toBe(4);
		expect(config.dispatch.monitor_interval_seconds).toBe(60);
		expect(config.dispatch.run_timeout_minutes).toBe(120);
		expect(config.shipping.auto_push).toBe(false);
	});

	test("throws if config file not found", async () => {
		await expect(loadConfig(join(TMP, "nonexistent.yaml"))).rejects.toThrow(
			"Config file not found",
		);
	});

	test("throws if repos is missing", async () => {
		const path = writeConfig("config.yaml", `version: "1"\n`);
		await expect(loadConfig(path)).rejects.toThrow("`repos` is required");
	});

	test("throws if repos is empty", async () => {
		const path = writeConfig("config.yaml", `version: "1"\nrepos: []\n`);
		await expect(loadConfig(path)).rejects.toThrow("`repos` is required");
	});

	test("throws if repo entry missing required fields", async () => {
		const path = writeConfig(
			"config.yaml",
			`version: "1"\nrepos:\n  - owner: jayminwest\n    repo: overstory\n`,
		);
		await expect(loadConfig(path)).rejects.toThrow("each repo must have");
	});

	test("loads multiple repos", async () => {
		const content = `version: "1"
repos:
  - owner: jayminwest
    repo: overstory
    labels:
      - agent-ready
    project_root: /path/to/overstory
  - owner: jayminwest
    repo: seeds
    labels:
      - agent-ready
      - bug
    project_root: /path/to/seeds
`;
		const path = writeConfig("config.yaml", content);
		const config = await loadConfig(path);
		expect(config.repos).toHaveLength(2);
		expect(config.repos[1]?.repo).toBe("seeds");
		expect(config.repos[1]?.labels).toEqual(["agent-ready", "bug"]);
	});
});
