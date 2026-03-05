/**
 * Tests for grhs doctor command
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Spawner } from "./doctor.ts";
import { runDoctorChecks } from "./doctor.ts";

const TEST_DIR = join(import.meta.dir, "__test_doctor__");

/**
 * Creates a mock spawner that returns preset results for specific commands.
 */
function makeMockSpawner(
	responses: Record<string, { exitCode: number; stdout: string; stderr: string }>,
): Spawner {
	return async (cmd: string[]) => {
		const key = cmd[0] ?? "";
		const response = responses[key] ?? { exitCode: 0, stdout: "", stderr: "" };
		return response;
	};
}

describe("runDoctorChecks", () => {
	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
		process.chdir(TEST_DIR);
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("returns checks for all required dependencies", async () => {
		const spawner = makeMockSpawner({
			gh: { exitCode: 0, stdout: "", stderr: "" },
			ov: { exitCode: 0, stdout: "0.8.5", stderr: "" },
			sd: { exitCode: 0, stdout: "0.4.0", stderr: "" },
			git: { exitCode: 0, stdout: "git version 2.39.0", stderr: "" },
		});

		const checks = await runDoctorChecks(spawner);

		const names = checks.map((c) => c.name);
		expect(names).toContain("gh-auth");
		expect(names).toContain("ov");
		expect(names).toContain("sd");
		expect(names).toContain("git");
		expect(names).toContain("config");
		expect(names).toContain("state");
	});

	it("fails gh-auth check when gh exits non-zero", async () => {
		const spawner = makeMockSpawner({
			gh: { exitCode: 1, stdout: "", stderr: "not logged in" },
			ov: { exitCode: 0, stdout: "0.8.5", stderr: "" },
			sd: { exitCode: 0, stdout: "0.4.0", stderr: "" },
			git: { exitCode: 0, stdout: "git version 2.39.0", stderr: "" },
		});

		const checks = await runDoctorChecks(spawner);
		const ghCheck = checks.find((c) => c.name === "gh-auth");

		expect(ghCheck).toBeDefined();
		expect(ghCheck?.status).toBe("fail");
	});

	it("passes config check when config.yaml exists", async () => {
		// Create config file
		mkdirSync(join(TEST_DIR, ".greenhouse"), { recursive: true });
		writeFileSync(join(TEST_DIR, ".greenhouse", "config.yaml"), 'version: "1"\nrepos: []\n');

		const spawner = makeMockSpawner({
			gh: { exitCode: 0, stdout: "", stderr: "" },
			ov: { exitCode: 0, stdout: "0.8.5", stderr: "" },
			sd: { exitCode: 0, stdout: "0.4.0", stderr: "" },
			git: { exitCode: 0, stdout: "git version 2.39.0", stderr: "" },
		});

		const checks = await runDoctorChecks(spawner);
		const configCheck = checks.find((c) => c.name === "config");

		expect(configCheck?.status).toBe("pass");
	});

	it("fails config check when config.yaml is missing", async () => {
		const spawner = makeMockSpawner({
			gh: { exitCode: 0, stdout: "", stderr: "" },
			ov: { exitCode: 0, stdout: "0.8.5", stderr: "" },
			sd: { exitCode: 0, stdout: "0.4.0", stderr: "" },
			git: { exitCode: 0, stdout: "git version 2.39.0", stderr: "" },
		});

		const checks = await runDoctorChecks(spawner);
		const configCheck = checks.find((c) => c.name === "config");

		expect(configCheck?.status).toBe("fail");
		expect(configCheck?.detail).toContain("grhs init");
	});

	it("warns about missing state.jsonl", async () => {
		// Create config but NOT state
		mkdirSync(join(TEST_DIR, ".greenhouse"), { recursive: true });
		writeFileSync(join(TEST_DIR, ".greenhouse", "config.yaml"), 'version: "1"\nrepos: []\n');

		const spawner = makeMockSpawner({
			gh: { exitCode: 0, stdout: "", stderr: "" },
			ov: { exitCode: 0, stdout: "0.8.5", stderr: "" },
			sd: { exitCode: 0, stdout: "0.4.0", stderr: "" },
			git: { exitCode: 0, stdout: "git version 2.39.0", stderr: "" },
		});

		const checks = await runDoctorChecks(spawner);
		const stateCheck = checks.find((c) => c.name === "state");

		expect(stateCheck?.status).toBe("warn");
	});

	it("passes state check when state.jsonl exists", async () => {
		mkdirSync(join(TEST_DIR, ".greenhouse"), { recursive: true });
		writeFileSync(join(TEST_DIR, ".greenhouse", "config.yaml"), 'version: "1"\nrepos: []\n');
		writeFileSync(join(TEST_DIR, ".greenhouse", "state.jsonl"), "");

		const spawner = makeMockSpawner({
			gh: { exitCode: 0, stdout: "", stderr: "" },
			ov: { exitCode: 0, stdout: "0.8.5", stderr: "" },
			sd: { exitCode: 0, stdout: "0.4.0", stderr: "" },
			git: { exitCode: 0, stdout: "git version 2.39.0", stderr: "" },
		});

		const checks = await runDoctorChecks(spawner);
		const stateCheck = checks.find((c) => c.name === "state");

		expect(stateCheck?.status).toBe("pass");
	});

	it("all checks pass when environment is fully set up", async () => {
		mkdirSync(join(TEST_DIR, ".greenhouse"), { recursive: true });
		writeFileSync(join(TEST_DIR, ".greenhouse", "config.yaml"), 'version: "1"\nrepos: []\n');
		writeFileSync(join(TEST_DIR, ".greenhouse", "state.jsonl"), "");

		const spawner = makeMockSpawner({
			gh: { exitCode: 0, stdout: "", stderr: "" },
			ov: { exitCode: 0, stdout: "0.8.5", stderr: "" },
			sd: { exitCode: 0, stdout: "0.4.0", stderr: "" },
			git: { exitCode: 0, stdout: "git version 2.39.0", stderr: "" },
		});

		const checks = await runDoctorChecks(spawner);
		const failing = checks.filter((c) => c.status === "fail");

		expect(failing).toHaveLength(0);
	});
});
