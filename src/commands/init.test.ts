/**
 * Tests for grhs init command
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { initGreenhouseDir } from "./init.ts";

const TEST_DIR = join(import.meta.dir, "__test_init__");

describe("initGreenhouseDir", () => {
	beforeEach(() => {
		// Create a fresh temp dir and cd into it
		mkdirSync(TEST_DIR, { recursive: true });
		process.chdir(TEST_DIR);
	});

	afterEach(() => {
		// Clean up
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("creates .greenhouse/ directory with config.yaml", async () => {
		const result = await initGreenhouseDir({});

		expect(result.success).toBe(true);
		expect(result.created).toBe(true);
		expect(existsSync(join(TEST_DIR, ".greenhouse", "config.yaml"))).toBe(true);
		expect(existsSync(join(TEST_DIR, ".greenhouse", "state.jsonl"))).toBe(true);
		expect(existsSync(join(TEST_DIR, ".greenhouse", ".gitignore"))).toBe(true);
	});

	it("fails if config already exists", async () => {
		// First init
		await initGreenhouseDir({});

		// Second init should fail
		const result = await initGreenhouseDir({});
		expect(result.success).toBe(false);
		expect(result.created).toBe(false);
		expect(result.error).toContain("already exists");
	});

	it("pre-configures repo when --repo is provided", async () => {
		const result = await initGreenhouseDir({ repo: "myorg/myrepo" });

		expect(result.success).toBe(true);
		const configContent = await Bun.file(join(TEST_DIR, ".greenhouse", "config.yaml")).text();
		expect(configContent).toContain("owner: myorg");
		expect(configContent).toContain("repo: myrepo");
	});

	it("fails with invalid --repo format", async () => {
		const result = await initGreenhouseDir({ repo: "invalid-no-slash" });

		expect(result.success).toBe(false);
		expect(result.error).toContain("Invalid --repo format");
	});

	it("config.yaml contains default values", async () => {
		await initGreenhouseDir({});

		const configContent = await Bun.file(join(TEST_DIR, ".greenhouse", "config.yaml")).text();
		expect(configContent).toContain("poll_interval_minutes: 10");
		expect(configContent).toContain("daily_cap: 5");
		expect(configContent).toContain("agent-ready");
	});

	it("state.jsonl is created as empty file", async () => {
		await initGreenhouseDir({});

		const content = await Bun.file(join(TEST_DIR, ".greenhouse", "state.jsonl")).text();
		expect(content).toBe("");
	});
});
