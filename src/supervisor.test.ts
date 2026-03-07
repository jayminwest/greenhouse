import { describe, expect, it } from "bun:test";
import {
	buildSupervisorBeacon,
	buildSupervisorCommand,
	isSupervisorAlive,
	killSupervisor,
	sendToSupervisor,
	spawnSupervisor,
	supervisorSessionName,
	supervisorSpecPath,
} from "./supervisor.ts";
import type { DaemonConfig, ExecResult, RepoConfig, SupervisorConfig } from "./types.ts";

// === Test Fixtures ===

const mockRepo: RepoConfig = {
	owner: "jayminwest",
	repo: "mulch",
	labels: ["status:triaged"],
	project_root: "/tmp/test-project",
};

const mockConfig: DaemonConfig = {
	version: "1",
	repos: [mockRepo],
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

function makeConfig(overrides?: Partial<SupervisorConfig>): SupervisorConfig {
	return {
		seedsId: "greenhouse-abc1",
		mergeBranch: "greenhouse/greenhouse-abc1",
		repo: mockRepo,
		config: mockConfig,
		...overrides,
	};
}

/** Build a mock ExecFn that records calls and returns preset responses in order. */
function makeMockExec(responses: Array<Partial<ExecResult>>) {
	const calls: string[][] = [];
	let index = 0;

	const exec = async (cmd: string[]): Promise<ExecResult> => {
		calls.push(cmd);
		const response = responses[index++] ?? { exitCode: 0, stdout: "", stderr: "" };
		return {
			exitCode: response.exitCode ?? 0,
			stdout: response.stdout ?? "",
			stderr: response.stderr ?? "",
		};
	};

	return { exec, calls };
}

// === Unit Tests: Pure Functions ===

describe("supervisorSessionName", () => {
	it("returns expected format", () => {
		expect(supervisorSessionName("greenhouse-abc1")).toBe("greenhouse-supervisor-greenhouse-abc1");
	});

	it("includes the seeds ID verbatim", () => {
		const name = supervisorSessionName("greenhouse-xyz9");
		expect(name).toContain("greenhouse-xyz9");
	});
});

describe("supervisorSpecPath", () => {
	it("returns path under .greenhouse/", () => {
		const p = supervisorSpecPath("greenhouse-abc1", "/tmp/my-project");
		expect(p).toBe("/tmp/my-project/.greenhouse/greenhouse-abc1-spec.md");
	});

	it("uses the seeds ID in the filename", () => {
		const p = supervisorSpecPath("greenhouse-xyz9", "/tmp/repo");
		expect(p).toContain("greenhouse-xyz9-spec.md");
	});
});

describe("buildSupervisorCommand", () => {
	it("includes model and bypassPermissions", () => {
		const cfg = makeConfig();
		const cmd = buildSupervisorCommand(cfg);
		expect(cmd).toContain("claude --model claude-sonnet-4-6");
		expect(cmd).toContain("--permission-mode bypassPermissions");
	});

	it("omits append-system-prompt when no specPath", () => {
		const cfg = makeConfig({ specPath: undefined });
		const cmd = buildSupervisorCommand(cfg);
		expect(cmd).not.toContain("--append-system-prompt");
	});

	it("includes append-system-prompt with cat expansion when specPath provided", () => {
		const cfg = makeConfig({ specPath: "/tmp/test-project/.greenhouse/greenhouse-abc1-spec.md" });
		const cmd = buildSupervisorCommand(cfg);
		expect(cmd).toContain("--append-system-prompt");
		expect(cmd).toContain("$(cat");
		expect(cmd).toContain("greenhouse-abc1-spec.md");
	});

	it("escapes single quotes in specPath", () => {
		const cfg = makeConfig({ specPath: "/tmp/it's/spec.md" });
		const cmd = buildSupervisorCommand(cfg);
		// Single quote in path should be escaped for safe shell embedding
		expect(cmd).not.toContain("it's");
		expect(cmd).toContain("it'\\''s");
	});
});

describe("buildSupervisorBeacon", () => {
	it("contains task seeds ID", () => {
		const cfg = makeConfig();
		const beacon = buildSupervisorBeacon(cfg);
		expect(beacon).toContain("task:greenhouse-abc1");
	});

	it("contains merge branch", () => {
		const cfg = makeConfig();
		const beacon = buildSupervisorBeacon(cfg);
		expect(beacon).toContain("branch:greenhouse/greenhouse-abc1");
	});

	it("contains repo owner/repo", () => {
		const cfg = makeConfig();
		const beacon = buildSupervisorBeacon(cfg);
		expect(beacon).toContain("repo:jayminwest/mulch");
	});

	it("contains project root", () => {
		const cfg = makeConfig();
		const beacon = buildSupervisorBeacon(cfg);
		expect(beacon).toContain("project:/tmp/test-project");
	});

	it("contains spec file path", () => {
		const cfg = makeConfig();
		const beacon = buildSupervisorBeacon(cfg);
		expect(beacon).toContain("spec:");
		expect(beacon).toContain("greenhouse-abc1-spec.md");
	});

	it("contains run timeout in minutes", () => {
		const cfg = makeConfig();
		const beacon = buildSupervisorBeacon(cfg);
		expect(beacon).toContain("timeout:");
		expect(beacon).toContain("min");
	});

	it("contains timestamp in ISO format", () => {
		const cfg = makeConfig();
		const beacon = buildSupervisorBeacon(cfg);
		// ISO timestamp like 2026-03-06T...Z
		expect(beacon).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});

	it("is a single line (no newlines)", () => {
		const cfg = makeConfig();
		const beacon = buildSupervisorBeacon(cfg);
		expect(beacon).not.toContain("\n");
	});

	it("uses run_timeout_minutes from config", () => {
		const cfgCustomTimeout = makeConfig({
			config: {
				...mockConfig,
				dispatch: {
					capability: "lead",
					max_concurrent: 2,
					monitor_interval_seconds: 30,
					run_timeout_minutes: 120,
				},
			},
		});
		const beacon = buildSupervisorBeacon(cfgCustomTimeout);
		expect(beacon).toContain("timeout:120min");
	});
});

// === Integration Tests: Functions with ExecFn ===

describe("isSupervisorAlive", () => {
	it("returns true when tmux has-session exits 0", async () => {
		const { exec } = makeMockExec([{ exitCode: 0 }]);
		const result = await isSupervisorAlive("greenhouse-supervisor-test", exec);
		expect(result).toBe(true);
	});

	it("returns false when tmux has-session exits non-zero", async () => {
		const { exec } = makeMockExec([{ exitCode: 1, stderr: "can't find session" }]);
		const result = await isSupervisorAlive("greenhouse-supervisor-test", exec);
		expect(result).toBe(false);
	});

	it("calls tmux has-session with the correct session name", async () => {
		const { exec, calls } = makeMockExec([{ exitCode: 0 }]);
		await isSupervisorAlive("greenhouse-supervisor-abc1", exec);
		expect(calls[0]).toEqual(["tmux", "has-session", "-t", "greenhouse-supervisor-abc1"]);
	});
});

describe("sendToSupervisor", () => {
	it("sends keys with Enter appended", async () => {
		const { exec, calls } = makeMockExec([{ exitCode: 0 }]);
		await sendToSupervisor("greenhouse-supervisor-abc1", "hello world", exec);
		expect(calls[0]).toEqual([
			"tmux",
			"send-keys",
			"-t",
			"greenhouse-supervisor-abc1",
			"hello world",
			"Enter",
		]);
	});

	it("flattens newlines to spaces", async () => {
		const { exec, calls } = makeMockExec([{ exitCode: 0 }]);
		await sendToSupervisor("test-session", "line1\nline2\nline3", exec);
		const sentText = calls[0]?.[4];
		expect(sentText).toBe("line1 line2 line3");
	});

	it("throws on non-zero exit code", async () => {
		const { exec } = makeMockExec([{ exitCode: 1, stderr: "session not found: test-session" }]);
		expect(sendToSupervisor("test-session", "hello", exec)).rejects.toThrow(
			"Failed to send keys to supervisor session",
		);
	});
});

describe("killSupervisor", () => {
	it("calls display-message, then pgrep, then kill-session", async () => {
		const { exec, calls } = makeMockExec([
			// tmux display-message for pane PID
			{ exitCode: 0, stdout: "99999\n" },
			// pgrep -P 99999 — no children
			{ exitCode: 1, stdout: "" },
			// tmux kill-session
			{ exitCode: 0 },
		]);

		await killSupervisor("greenhouse-supervisor-abc1", exec, 0);

		expect(calls[0]).toEqual([
			"tmux",
			"display-message",
			"-p",
			"-t",
			"greenhouse-supervisor-abc1",
			"#{pane_pid}",
		]);
		// Last call should be kill-session
		const lastCall = calls[calls.length - 1];
		expect(lastCall).toEqual(["tmux", "kill-session", "-t", "greenhouse-supervisor-abc1"]);
	});

	it("does not throw when session already gone", async () => {
		const { exec } = makeMockExec([
			// display-message fails (session already gone)
			{ exitCode: 1, stderr: "can't find session: greenhouse-supervisor-abc1" },
			// kill-session also fails with session not found
			{ exitCode: 1, stderr: "session not found: greenhouse-supervisor-abc1" },
		]);

		// Should not throw
		await expect(killSupervisor("greenhouse-supervisor-abc1", exec, 0)).resolves.toBeUndefined();
	});

	it("walks descendant PIDs and sends signals", async () => {
		const { exec, calls } = makeMockExec([
			// pane PID
			{ exitCode: 0, stdout: "1000\n" },
			// pgrep children of 1000
			{ exitCode: 0, stdout: "1001\n1002\n" },
			// pgrep children of 1001 (no children)
			{ exitCode: 1, stdout: "" },
			// pgrep children of 1002 (no children)
			{ exitCode: 1, stdout: "" },
			// kill-session
			{ exitCode: 0 },
		]);

		await killSupervisor("greenhouse-supervisor-abc1", exec, 0);

		// Verify pgrep was called for each child
		const pgrepCalls = calls.filter((c) => c[0] === "pgrep");
		expect(pgrepCalls.length).toBe(3); // 1000, 1001, 1002
	});

	it("throws on unexpected kill-session failure", async () => {
		const { exec } = makeMockExec([
			// display-message fails (no PID)
			{ exitCode: 1, stdout: "" },
			// kill-session fails with unknown error
			{ exitCode: 1, stderr: "some unexpected tmux error" },
		]);

		await expect(killSupervisor("greenhouse-supervisor-abc1", exec, 0)).rejects.toThrow(
			"Failed to kill supervisor session",
		);
	});
});

describe("spawnSupervisor", () => {
	/** Build a standard mock exec for a successful spawnSupervisor call. */
	function makeSpawnMock(overrides?: { captureContent?: string }) {
		const captureContent = overrides?.captureContent ?? "❯ shift+tab bypass permissions";
		return makeMockExec([
			// tmux new-session
			{ exitCode: 0 },
			// tmux list-panes (pane PID)
			{ exitCode: 0, stdout: "12345\n" },
			// tmux capture-pane (TUI ready immediately)
			{ exitCode: 0, stdout: captureContent },
			// tmux send-keys (beacon)
			{ exitCode: 0 },
		]);
	}

	it("returns sessionName and pid on success", async () => {
		const { exec } = makeSpawnMock();
		const cfg = makeConfig();
		const result = await spawnSupervisor(cfg, exec);

		expect(result.sessionName).toBe("greenhouse-supervisor-greenhouse-abc1");
		expect(result.pid).toBe(12345);
	});

	it("creates tmux session with correct name and cwd", async () => {
		const { exec, calls } = makeSpawnMock();
		await spawnSupervisor(makeConfig(), exec);

		const newSession = calls.find((c) => c.includes("new-session"));
		expect(newSession).toBeDefined();
		expect(newSession).toContain("greenhouse-supervisor-greenhouse-abc1");
		expect(newSession).toContain("/tmp/test-project");
	});

	it("wraps command in /bin/bash -c with nesting guards unset", async () => {
		const { exec, calls } = makeSpawnMock();
		await spawnSupervisor(makeConfig(), exec);

		const newSession = calls.find((c) => c.includes("new-session"));
		const cmd = newSession?.join(" ") ?? "";
		expect(cmd).toContain("/bin/bash -c");
		expect(cmd).toContain("unset CLAUDECODE");
		expect(cmd).toContain("CLAUDE_CODE_SSE_PORT");
		expect(cmd).toContain("CLAUDE_CODE_ENTRYPOINT");
	});

	it("includes OVERSTORY_AGENT_NAME in environment", async () => {
		const { exec, calls } = makeSpawnMock();
		await spawnSupervisor(makeConfig(), exec);

		const newSession = calls.find((c) => c.includes("new-session"));
		const cmd = newSession?.join(" ") ?? "";
		expect(cmd).toContain("OVERSTORY_AGENT_NAME");
		expect(cmd).toContain("greenhouse-supervisor-greenhouse-abc1");
	});

	it("sends beacon after TUI is ready", async () => {
		const { exec, calls } = makeSpawnMock();
		await spawnSupervisor(makeConfig(), exec);

		const sendKeys = calls.filter((c) => c[0] === "tmux" && c[1] === "send-keys");
		// At least one send-keys call (the beacon)
		expect(sendKeys.length).toBeGreaterThanOrEqual(1);
		// Last send-keys call should have the beacon content
		const beaconCall = sendKeys[sendKeys.length - 1];
		expect(beaconCall?.[4]).toContain("greenhouse-abc1");
		expect(beaconCall?.[5]).toBe("Enter");
	});

	it("throws when tmux new-session fails", async () => {
		const { exec } = makeMockExec([{ exitCode: 1, stderr: "tmux: session already exists" }]);
		await expect(spawnSupervisor(makeConfig(), exec)).rejects.toThrow(
			"Failed to create supervisor tmux session",
		);
	});

	it("throws when pane PID cannot be retrieved", async () => {
		const { exec } = makeMockExec([
			{ exitCode: 0 }, // new-session succeeds
			{ exitCode: 1, stderr: "no pane found" }, // list-panes fails
		]);
		await expect(spawnSupervisor(makeConfig(), exec)).rejects.toThrow("failed to retrieve PID");
	});

	it("throws when session dies during TUI readiness wait", async () => {
		const { exec } = makeMockExec([
			{ exitCode: 0 }, // new-session
			{ exitCode: 0, stdout: "12345\n" }, // list-panes
			{ exitCode: 1, stdout: "" }, // capture-pane fails (session dead)
			{ exitCode: 1, stderr: "session not found" }, // has-session confirms dead
		]);
		await expect(spawnSupervisor(makeConfig(), exec)).rejects.toThrow("died during startup");
	});

	it("includes spec file in claude command when specPath is provided", async () => {
		const { exec, calls } = makeSpawnMock();
		const cfg = makeConfig({ specPath: "/tmp/test-project/.greenhouse/greenhouse-abc1-spec.md" });
		await spawnSupervisor(cfg, exec);

		const newSession = calls.find((c) => c.includes("new-session"));
		const cmd = newSession?.join(" ") ?? "";
		expect(cmd).toContain("append-system-prompt");
		expect(cmd).toContain("greenhouse-abc1-spec.md");
	});
});
