import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
		const result = parseYaml(`version: "1"\npoll_interval_minutes: 10\nrun_timeout_minutes: 90\n`);
		expect(result.version).toBe("1");
		expect(result.poll_interval_minutes).toBe(10);
		expect(result.run_timeout_minutes).toBe(90);
	});

	test("parses nested objects", () => {
		const result = parseYaml("outer:\n  inner_key: value\n  count: 2\n");
		expect(result.outer).toEqual({ inner_key: "value", count: 2 });
	});

	test("parses string arrays", () => {
		const result = parseYaml("labels:\n  - agent-ready\n  - bug\n");
		expect(result.labels).toEqual(["agent-ready", "bug"]);
	});

	test("parses object arrays", () => {
		const yaml =
			"repos:\n  - owner: jayminwest\n    repo: overstory\n    ready_label: greenhouse:ready\n";
		const result = parseYaml(yaml);
		const repos = result.repos as Array<Record<string, unknown>>;
		expect(repos).toHaveLength(1);
		expect(repos[0]?.owner).toBe("jayminwest");
		expect(repos[0]?.repo).toBe("overstory");
		expect(repos[0]?.ready_label).toBe("greenhouse:ready");
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
    ready_label: "greenhouse:ready"
`;

describe("loadConfig", () => {
	test("loads minimal config with defaults", async () => {
		const path = writeConfig("config.yaml", MINIMAL_CONFIG);
		const config = await loadConfig(path);
		expect(config.version).toBe("1");
		expect(config.repos).toHaveLength(1);
		expect(config.repos[0]?.owner).toBe("jayminwest");
		expect(config.repos[0]?.repo).toBe("overstory");
		expect(config.repos[0]?.ready_label).toBe("greenhouse:ready");
		// Defaults
		expect(config.poll_interval_minutes).toBe(10);
		expect(config.run_timeout_minutes).toBe(90);
		expect(config.clone_root).toBe(join(homedir(), ".greenhouse", "runs"));
	});

	test("loads all new top-level fields", async () => {
		const content = `version: "1"
clone_root: /custom/clone/root
poll_interval_minutes: 15
run_timeout_minutes: 120
repos:
  - owner: jayminwest
    repo: overstory
    ready_label: "greenhouse:ready"
`;
		const path = writeConfig("config.yaml", content);
		const config = await loadConfig(path);
		expect(config.clone_root).toBe("/custom/clone/root");
		expect(config.poll_interval_minutes).toBe(15);
		expect(config.run_timeout_minutes).toBe(120);
	});

	test("expands ~ in clone_root", async () => {
		const content = `${MINIMAL_CONFIG}clone_root: ~/.greenhouse/runs\n`;
		const path = writeConfig("config.yaml", content);
		const config = await loadConfig(path);
		expect(config.clone_root).toBe(join(homedir(), ".greenhouse", "runs"));
	});

	test("loads optional per-repo fields", async () => {
		const content = `version: "1"
repos:
  - owner: jayminwest
    repo: mulch
    ready_label: "greenhouse:ready"
    failed_label: "greenhouse:failed"
    clone_url: "git@github.com:jayminwest/mulch.git"
    base_branch: main
`;
		const path = writeConfig("config.yaml", content);
		const config = await loadConfig(path);
		expect(config.repos[0]?.failed_label).toBe("greenhouse:failed");
		expect(config.repos[0]?.clone_url).toBe("git@github.com:jayminwest/mulch.git");
		expect(config.repos[0]?.base_branch).toBe("main");
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

	test("throws if repo entry missing ready_label", async () => {
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
    ready_label: "greenhouse:ready"
  - owner: jayminwest
    repo: seeds
    ready_label: "greenhouse:ready"
    failed_label: "greenhouse:failed"
`;
		const path = writeConfig("config.yaml", content);
		const config = await loadConfig(path);
		expect(config.repos).toHaveLength(2);
		expect(config.repos[1]?.repo).toBe("seeds");
		expect(config.repos[1]?.failed_label).toBe("greenhouse:failed");
	});

	// ─── Legacy field rejection ──────────────────────────────────────────────

	test("rejects legacy top-level: daily_cap", async () => {
		const content = `${MINIMAL_CONFIG}daily_cap: 5\n`;
		const path = writeConfig("config.yaml", content);
		await expect(loadConfig(path)).rejects.toThrow("`daily_cap` was removed in v0.2.0");
	});

	test("rejects legacy top-level: dispatch", async () => {
		const content = `${MINIMAL_CONFIG}dispatch:\n  run_timeout_minutes: 90\n`;
		const path = writeConfig("config.yaml", content);
		await expect(loadConfig(path)).rejects.toThrow("`dispatch` was removed in v0.2.0");
	});

	test("rejects legacy top-level: shipping", async () => {
		const content = `${MINIMAL_CONFIG}shipping:\n  auto_push: true\n`;
		const path = writeConfig("config.yaml", content);
		await expect(loadConfig(path)).rejects.toThrow("`shipping` was removed in v0.2.0");
	});

	test("rejects legacy per-repo: project_root", async () => {
		const content = `version: "1"
repos:
  - owner: jayminwest
    repo: overstory
    ready_label: "greenhouse:ready"
    project_root: /path/to/repo
`;
		const path = writeConfig("config.yaml", content);
		await expect(loadConfig(path)).rejects.toThrow("`project_root` was removed in v0.2.0");
	});

	test("rejects legacy per-repo: labels array", async () => {
		const content = `version: "1"
repos:
  - owner: jayminwest
    repo: overstory
    ready_label: "greenhouse:ready"
    labels:
      - agent-ready
`;
		const path = writeConfig("config.yaml", content);
		await expect(loadConfig(path)).rejects.toThrow("`labels` was removed in v0.2.0");
	});
});
