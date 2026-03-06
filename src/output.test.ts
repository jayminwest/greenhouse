/**
 * Tests for output.ts — global CLI option state and helpers.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	isJsonMode,
	isQuietMode,
	isTimingMode,
	isVerboseMode,
	printDebug,
	printElapsed,
	printInfo,
	printWarning,
	setJsonMode,
	setQuietMode,
	setTimingMode,
	setVerboseMode,
	startTiming,
} from "./output.ts";

describe("quiet mode", () => {
	beforeEach(() => {
		setQuietMode(false);
		setJsonMode(false);
	});

	afterEach(() => {
		setQuietMode(false);
		setJsonMode(false);
	});

	it("isQuietMode returns false by default", () => {
		expect(isQuietMode()).toBe(false);
	});

	it("setQuietMode toggles state", () => {
		setQuietMode(true);
		expect(isQuietMode()).toBe(true);
		setQuietMode(false);
		expect(isQuietMode()).toBe(false);
	});

	it("printInfo is suppressed in quiet mode", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		setQuietMode(true);
		printInfo("test message");
		expect(spy.mock.calls.length).toBe(0);
		spy.mockRestore();
	});

	it("printInfo outputs when quiet mode is off", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		setQuietMode(false);
		printInfo("test message");
		expect(spy.mock.calls.length).toBe(1);
		spy.mockRestore();
	});

	it("printWarning is suppressed in quiet mode", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		setQuietMode(true);
		printWarning("warning message");
		expect(spy.mock.calls.length).toBe(0);
		spy.mockRestore();
	});

	it("printWarning outputs when quiet mode is off", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		setQuietMode(false);
		printWarning("warning message");
		expect(spy.mock.calls.length).toBe(1);
		spy.mockRestore();
	});
});

describe("verbose mode", () => {
	beforeEach(() => {
		setVerboseMode(false);
	});

	afterEach(() => {
		setVerboseMode(false);
	});

	it("isVerboseMode returns false by default", () => {
		expect(isVerboseMode()).toBe(false);
	});

	it("setVerboseMode toggles state", () => {
		setVerboseMode(true);
		expect(isVerboseMode()).toBe(true);
		setVerboseMode(false);
		expect(isVerboseMode()).toBe(false);
	});

	it("printDebug is suppressed when verbose mode is off", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		setVerboseMode(false);
		printDebug("debug message");
		expect(spy.mock.calls.length).toBe(0);
		spy.mockRestore();
	});

	it("printDebug outputs when verbose mode is on", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		setVerboseMode(true);
		printDebug("debug message");
		expect(spy.mock.calls.length).toBe(1);
		spy.mockRestore();
	});
});

describe("timing mode", () => {
	beforeEach(() => {
		setTimingMode(false);
		setJsonMode(false);
	});

	afterEach(() => {
		setTimingMode(false);
		setJsonMode(false);
	});

	it("isTimingMode returns false by default", () => {
		expect(isTimingMode()).toBe(false);
	});

	it("setTimingMode toggles state", () => {
		setTimingMode(true);
		expect(isTimingMode()).toBe(true);
		setTimingMode(false);
		expect(isTimingMode()).toBe(false);
	});

	it("printElapsed is suppressed when timing mode is off", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		setTimingMode(false);
		printElapsed();
		expect(spy.mock.calls.length).toBe(0);
		spy.mockRestore();
	});

	it("printElapsed outputs when timing mode is on", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		startTiming();
		setTimingMode(true);
		printElapsed();
		expect(spy.mock.calls.length).toBe(1);
		const output = String(spy.mock.calls[0]);
		expect(output).toContain("s");
		spy.mockRestore();
	});

	it("printElapsed uses custom label", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		startTiming();
		setTimingMode(true);
		printElapsed("Command time");
		const output = String(spy.mock.calls[0]);
		expect(output).toContain("Command time");
		spy.mockRestore();
	});

	it("printElapsed writes to stderr in JSON mode", () => {
		const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
		startTiming();
		setTimingMode(true);
		setJsonMode(true);
		printElapsed();
		expect(spy.mock.calls.length).toBe(1);
		const output = String(spy.mock.calls[0]);
		expect(output).toContain("s");
		spy.mockRestore();
	});
});

describe("isJsonMode", () => {
	beforeEach(() => {
		setJsonMode(false);
	});

	afterEach(() => {
		setJsonMode(false);
	});

	it("returns false by default", () => {
		expect(isJsonMode()).toBe(false);
	});

	it("returns true after setJsonMode(true)", () => {
		setJsonMode(true);
		expect(isJsonMode()).toBe(true);
	});

	it("printInfo is suppressed in JSON mode", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		setJsonMode(true);
		printInfo("should not appear");
		expect(spy.mock.calls.length).toBe(0);
		spy.mockRestore();
	});
});
