import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	compactDuration,
	computeStageDurations,
	formatDuration,
	isJsonMode,
	isQuietMode,
	isTimingMode,
	isVerboseMode,
	outputJson,
	printBudget,
	printDebug,
	printElapsed,
	printError,
	printInfo,
	printRunFull,
	printRunOneLine,
	printSuccess,
	printWarning,
	setJsonMode,
	setQuietMode,
	setTimingMode,
	setVerboseMode,
	startTiming,
} from "./output.ts";
import type { DailyBudget, RunState } from "./types.ts";

function makeRun(overrides: Partial<RunState> = {}): RunState {
	return {
		ghIssueId: 42,
		ghRepo: "jayminwest/greenhouse",
		ghTitle: "Test issue title",
		ghLabels: ["status:triaged"],
		seedsId: "greenhouse-1a2b",
		status: "running",
		discoveredAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T01:00:00Z",
		...overrides,
	};
}

function makeBudget(overrides: Partial<DailyBudget> = {}): DailyBudget {
	return {
		date: "2026-01-01",
		dispatched: 2,
		cap: 5,
		remaining: 3,
		...overrides,
	};
}

// Reset all mode flags after each test
afterEach(() => {
	setJsonMode(false);
	setQuietMode(false);
	setVerboseMode(false);
	setTimingMode(false);
});

describe("formatDuration", () => {
	test("formats seconds", () => {
		expect(formatDuration(5000)).toBe("5s");
	});

	test("formats minutes and seconds", () => {
		expect(formatDuration(8 * 60 * 1000 + 23 * 1000)).toBe("8m 23s");
	});

	test("formats hours and minutes", () => {
		expect(formatDuration(1 * 3600 * 1000 + 2 * 60 * 1000)).toBe("1h 2m");
	});

	test("formats 0ms as 0s", () => {
		expect(formatDuration(0)).toBe("0s");
	});
});

describe("computeStageDurations", () => {
	test("returns isRunning true when status is running", () => {
		const run = makeRun({
			status: "running",
			dispatchedAt: new Date(Date.now() - 5000).toISOString(),
		});
		const d = computeStageDurations(run);
		expect(d.isRunning).toBe(true);
		expect(d.agentMs).toBeGreaterThan(0);
	});

	test("returns isRunning false for non-running status", () => {
		const run = makeRun({ status: "shipped" });
		const d = computeStageDurations(run);
		expect(d.isRunning).toBe(false);
	});

	test("computes ingestMs from discoveredAt to ingestedAt", () => {
		const discovered = new Date(Date.now() - 10000).toISOString();
		const ingested = new Date(Date.now() - 8000).toISOString();
		const run = makeRun({ discoveredAt: discovered, ingestedAt: ingested });
		const d = computeStageDurations(run);
		expect(d.ingestMs).toBeCloseTo(2000, -2);
	});

	test("computes shippingMs from completedAt to shippedAt", () => {
		const completed = new Date(Date.now() - 4000).toISOString();
		const shipped = new Date(Date.now() - 1000).toISOString();
		const run = makeRun({ status: "shipped", completedAt: completed, shippedAt: shipped });
		const d = computeStageDurations(run);
		expect(d.shippingMs).toBeCloseTo(3000, -2);
	});

	test("computes totalMs from discoveredAt to shippedAt for shipped run", () => {
		const discovered = new Date(Date.now() - 20000).toISOString();
		const shipped = new Date(Date.now() - 1000).toISOString();
		const run = makeRun({ status: "shipped", discoveredAt: discovered, shippedAt: shipped });
		const d = computeStageDurations(run);
		expect(d.totalMs).toBeCloseTo(19000, -2);
	});
});

describe("compactDuration", () => {
	test("returns 'running Xs' for active runs", () => {
		const run = makeRun({
			status: "running",
			dispatchedAt: new Date(Date.now() - 5000).toISOString(),
		});
		const result = compactDuration(run);
		expect(result).toMatch(/^running \d+s$/);
	});

	test("returns total duration for shipped runs", () => {
		const discovered = new Date(Date.now() - 10000).toISOString();
		const shipped = new Date(Date.now() - 1000).toISOString();
		const run = makeRun({ status: "shipped", discoveredAt: discovered, shippedAt: shipped });
		const result = compactDuration(run);
		expect(result).toMatch(/^\d+s$|^\d+m \d+s$|^\d+h \d+m$/);
	});

	test("returns empty string when no durations available", () => {
		const run = makeRun({ status: "pending" });
		const result = compactDuration(run);
		expect(result).toBe("");
	});
});

describe("mode getters/setters", () => {
	test("setJsonMode / isJsonMode", () => {
		expect(isJsonMode()).toBe(false);
		setJsonMode(true);
		expect(isJsonMode()).toBe(true);
	});

	test("setQuietMode / isQuietMode", () => {
		expect(isQuietMode()).toBe(false);
		setQuietMode(true);
		expect(isQuietMode()).toBe(true);
	});

	test("setVerboseMode / isVerboseMode", () => {
		expect(isVerboseMode()).toBe(false);
		setVerboseMode(true);
		expect(isVerboseMode()).toBe(true);
	});

	test("setTimingMode / isTimingMode", () => {
		expect(isTimingMode()).toBe(false);
		setTimingMode(true);
		expect(isTimingMode()).toBe(true);
	});
});

describe("timing", () => {
	test("printElapsed is suppressed when timing mode is off", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		setTimingMode(false);
		printElapsed();
		expect(spy).toHaveBeenCalledTimes(0);
		spy.mockRestore();
	});

	test("printElapsed outputs when timing mode is on", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		startTiming();
		setTimingMode(true);
		printElapsed();
		expect(spy).toHaveBeenCalledTimes(1);
		const output = String(spy.mock.calls[0]);
		expect(output).toContain("s");
		spy.mockRestore();
	});

	test("printElapsed uses custom label", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		startTiming();
		setTimingMode(true);
		printElapsed("Command time");
		const output = String(spy.mock.calls[0]);
		expect(output).toContain("Command time");
		spy.mockRestore();
	});

	test("printElapsed writes to stderr in JSON mode", () => {
		const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
		startTiming();
		setTimingMode(true);
		setJsonMode(true);
		printElapsed();
		expect(spy).toHaveBeenCalledTimes(1);
		const output = String(spy.mock.calls[0]);
		expect(output).toContain("s");
		spy.mockRestore();
	});
});

describe("printSuccess", () => {
	test("outputs when no mode set", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		printSuccess("hello");
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	test("suppressed in json mode", () => {
		setJsonMode(true);
		const spy = spyOn(console, "log").mockImplementation(() => {});
		printSuccess("hello");
		expect(spy).toHaveBeenCalledTimes(0);
		spy.mockRestore();
	});

	test("suppressed in quiet mode", () => {
		setQuietMode(true);
		const spy = spyOn(console, "log").mockImplementation(() => {});
		printSuccess("hello");
		expect(spy).toHaveBeenCalledTimes(0);
		spy.mockRestore();
	});
});

describe("printError", () => {
	test("always outputs (not suppressed by quiet)", () => {
		setQuietMode(true);
		const spy = spyOn(console, "error").mockImplementation(() => {});
		printError("something broke");
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	test("always outputs (not suppressed by json mode)", () => {
		setJsonMode(true);
		const spy = spyOn(console, "error").mockImplementation(() => {});
		printError("something broke");
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});
});

describe("printWarning", () => {
	test("outputs when no mode set", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		printWarning("careful");
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	test("suppressed in quiet mode", () => {
		setQuietMode(true);
		const spy = spyOn(console, "log").mockImplementation(() => {});
		printWarning("careful");
		expect(spy).toHaveBeenCalledTimes(0);
		spy.mockRestore();
	});

	test("suppressed in json mode", () => {
		setJsonMode(true);
		const spy = spyOn(console, "log").mockImplementation(() => {});
		printWarning("careful");
		expect(spy).toHaveBeenCalledTimes(0);
		spy.mockRestore();
	});
});

describe("printInfo", () => {
	test("outputs when no mode set", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		printInfo("info");
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	test("suppressed in quiet mode", () => {
		setQuietMode(true);
		const spy = spyOn(console, "log").mockImplementation(() => {});
		printInfo("info");
		expect(spy).toHaveBeenCalledTimes(0);
		spy.mockRestore();
	});

	test("suppressed in json mode", () => {
		setJsonMode(true);
		const spy = spyOn(console, "log").mockImplementation(() => {});
		printInfo("info");
		expect(spy).toHaveBeenCalledTimes(0);
		spy.mockRestore();
	});
});

describe("printDebug", () => {
	test("suppressed when verbose mode off", () => {
		const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
		printDebug("debug message");
		expect(spy).toHaveBeenCalledTimes(0);
		spy.mockRestore();
	});

	test("outputs to stderr when verbose mode on", () => {
		setVerboseMode(true);
		const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
		printDebug("debug message");
		expect(spy).toHaveBeenCalledTimes(1);
		const call = spy.mock.calls[0]?.[0];
		expect(String(call)).toContain("debug message");
		spy.mockRestore();
	});
});

describe("printRunOneLine", () => {
	test("outputs when no mode set", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		printRunOneLine(makeRun());
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	test("suppressed in quiet mode", () => {
		setQuietMode(true);
		const spy = spyOn(console, "log").mockImplementation(() => {});
		printRunOneLine(makeRun());
		expect(spy).toHaveBeenCalledTimes(0);
		spy.mockRestore();
	});

	test("suppressed in json mode", () => {
		setJsonMode(true);
		const spy = spyOn(console, "log").mockImplementation(() => {});
		printRunOneLine(makeRun());
		expect(spy).toHaveBeenCalledTimes(0);
		spy.mockRestore();
	});
});

describe("printRunFull", () => {
	test("outputs when no mode set", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		printRunFull(makeRun());
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});

	test("suppressed in quiet mode", () => {
		setQuietMode(true);
		const spy = spyOn(console, "log").mockImplementation(() => {});
		printRunFull(makeRun());
		expect(spy).toHaveBeenCalledTimes(0);
		spy.mockRestore();
	});
});

describe("printBudget", () => {
	test("outputs when no mode set", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		printBudget(makeBudget());
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	test("suppressed in quiet mode", () => {
		setQuietMode(true);
		const spy = spyOn(console, "log").mockImplementation(() => {});
		printBudget(makeBudget());
		expect(spy).toHaveBeenCalledTimes(0);
		spy.mockRestore();
	});

	test("suppressed in json mode", () => {
		setJsonMode(true);
		const spy = spyOn(console, "log").mockImplementation(() => {});
		printBudget(makeBudget());
		expect(spy).toHaveBeenCalledTimes(0);
		spy.mockRestore();
	});
});

describe("outputJson", () => {
	test("always outputs JSON", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		outputJson({ key: "value" });
		expect(spy).toHaveBeenCalledTimes(1);
		const output = spy.mock.calls[0]?.[0] as string;
		expect(JSON.parse(output)).toEqual({ key: "value" });
		spy.mockRestore();
	});
});
