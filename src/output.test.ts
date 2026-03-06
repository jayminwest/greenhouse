import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
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
