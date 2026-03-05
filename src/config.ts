import { join } from "node:path";
import type { DaemonConfig, RepoConfig } from "./types.ts";
import { CONFIG_FILE, DEFAULT_PR_TEMPLATE, GREENHOUSE_DIR } from "./types.ts";

// ─── YAML parser ─────────────────────────────────────────────────────────────
// Supports: nested objects, string arrays, block scalars (|), booleans, numbers.
// Does NOT support: flow mappings/sequences, anchors/aliases, tags.

function countIndent(line: string): number {
	let count = 0;
	for (const ch of line) {
		if (ch === " ") count++;
		else if (ch === "\t") count += 2;
		else break;
	}
	return count;
}

function stripComment(line: string): string {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle) inDouble = !inDouble;
		else if (ch === "#" && !inSingle && !inDouble) {
			return line.slice(0, i);
		}
	}
	return line;
}

function parseScalar(raw: string): unknown {
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (raw === "null" || raw === "~") return null;
	if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
	if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
	if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
		return raw.slice(1, -1);
	}
	return raw;
}

function findLastKey(obj: Record<string, unknown>): string | null {
	const keys = Object.keys(obj);
	return keys.length > 0 ? (keys[keys.length - 1] ?? null) : null;
}

export function parseYaml(text: string): Record<string, unknown> {
	const lines = text.split("\n");
	const root: Record<string, unknown> = {};
	const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [
		{ indent: -1, obj: root },
	];

	let i = 0;
	while (i < lines.length) {
		const rawLine = lines[i];
		if (rawLine === undefined) {
			i++;
			continue;
		}

		const commentFree = stripComment(rawLine).trimEnd();
		if (commentFree.trim() === "") {
			i++;
			continue;
		}

		const indent = countIndent(commentFree);
		const content = commentFree.trim();

		// Pop stack to find the correct parent for this indent level
		while (stack.length > 1) {
			const top = stack[stack.length - 1];
			if (top && top.indent >= indent) stack.pop();
			else break;
		}

		const parent = stack[stack.length - 1];
		if (!parent) {
			i++;
			continue;
		}

		// Array item: "- value" or "- key: val"
		if (content.startsWith("- ")) {
			const value = content.slice(2).trim();
			const colonIdx = value.indexOf(":");
			const isObjectItem =
				colonIdx > 0 &&
				!value.startsWith('"') &&
				!value.startsWith("'") &&
				/^[\w-]+$/.test(value.slice(0, colonIdx).trim());

			if (isObjectItem) {
				const itemKey = value.slice(0, colonIdx).trim();
				const itemVal = value.slice(colonIdx + 1).trim();
				const newItem: Record<string, unknown> = {};
				newItem[itemKey] = itemVal !== "" ? parseScalar(itemVal) : {};

				const lastKey = findLastKey(parent.obj);
				if (lastKey !== null) {
					const existing = parent.obj[lastKey];
					if (Array.isArray(existing)) {
						existing.push(newItem);
						stack.push({ indent, obj: newItem });
						i++;
						continue;
					}
				}
				if (stack.length >= 2) {
					const grandparent = stack[stack.length - 2];
					if (grandparent) {
						const gpKey = findLastKey(grandparent.obj);
						if (gpKey !== null) {
							const gpVal = grandparent.obj[gpKey];
							if (
								gpVal !== null &&
								gpVal !== undefined &&
								typeof gpVal === "object" &&
								!Array.isArray(gpVal) &&
								Object.keys(gpVal as Record<string, unknown>).length === 0
							) {
								grandparent.obj[gpKey] = [newItem];
								stack.pop();
								stack.push({ indent, obj: newItem });
								i++;
								continue;
							}
						}
					}
				}
			} else {
				// Scalar array item
				const lastKey = findLastKey(parent.obj);
				if (lastKey !== null) {
					const existing = parent.obj[lastKey];
					if (Array.isArray(existing)) {
						existing.push(parseScalar(value));
						i++;
						continue;
					}
				}
				if (stack.length >= 2) {
					const grandparent = stack[stack.length - 2];
					if (grandparent) {
						const gpKey = findLastKey(grandparent.obj);
						if (gpKey !== null) {
							const gpVal = grandparent.obj[gpKey];
							if (
								gpVal !== null &&
								gpVal !== undefined &&
								typeof gpVal === "object" &&
								!Array.isArray(gpVal) &&
								Object.keys(gpVal as Record<string, unknown>).length === 0
							) {
								grandparent.obj[gpKey] = [parseScalar(value)];
								stack.pop();
								i++;
								continue;
							}
						}
					}
				}
			}
			i++;
			continue;
		}

		// Key: value pair
		const colonIndex = content.indexOf(":");
		if (colonIndex === -1) {
			i++;
			continue;
		}

		const key = content.slice(0, colonIndex).trim();
		const rawValue = content.slice(colonIndex + 1).trim();

		// Block scalar: |
		if (rawValue === "|") {
			const blockLines: string[] = [];
			const baseIndent = indent + 2; // expect at least 2 more spaces
			i++;
			while (i < lines.length) {
				const bl = lines[i];
				if (bl === undefined) break;
				if (bl.trim() === "") {
					blockLines.push("");
					i++;
					continue;
				}
				if (countIndent(bl) < baseIndent) break;
				blockLines.push(bl.slice(baseIndent));
				i++;
			}
			// Trim trailing empty lines, keep final newline
			while (blockLines.length > 0 && blockLines[blockLines.length - 1] === "") {
				blockLines.pop();
			}
			parent.obj[key] = `${blockLines.join("\n")}\n`;
			continue;
		}

		if (rawValue === "" || rawValue === undefined) {
			const nested: Record<string, unknown> = {};
			parent.obj[key] = nested;
			stack.push({ indent, obj: nested });
		} else if (rawValue === "[]") {
			parent.obj[key] = [];
		} else {
			parent.obj[key] = parseScalar(rawValue);
		}
		i++;
	}

	return root;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Omit<DaemonConfig, "repos" | "version"> = {
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
		pr_template: DEFAULT_PR_TEMPLATE,
	},
};

// ─── Validation ───────────────────────────────────────────────────────────────

function isRepoConfig(r: unknown): r is RepoConfig {
	if (!r || typeof r !== "object") return false;
	const obj = r as Record<string, unknown>;
	return (
		typeof obj.owner === "string" &&
		typeof obj.repo === "string" &&
		Array.isArray(obj.labels) &&
		typeof obj.project_root === "string"
	);
}

function validateConfig(raw: Record<string, unknown>): DaemonConfig {
	if (!Array.isArray(raw.repos) || raw.repos.length === 0) {
		throw new Error("config.yaml: `repos` is required and must be a non-empty array");
	}
	for (const r of raw.repos) {
		if (!isRepoConfig(r)) {
			throw new Error(
				"config.yaml: each repo must have owner, repo (strings), labels (array), and project_root (string)",
			);
		}
	}

	const repos = raw.repos as RepoConfig[];
	const version = typeof raw.version === "string" ? raw.version : "1";

	const dispatch =
		raw.dispatch && typeof raw.dispatch === "object"
			? (raw.dispatch as Record<string, unknown>)
			: {};
	const shipping =
		raw.shipping && typeof raw.shipping === "object"
			? (raw.shipping as Record<string, unknown>)
			: {};

	return {
		version,
		repos,
		poll_interval_minutes:
			typeof raw.poll_interval_minutes === "number"
				? raw.poll_interval_minutes
				: DEFAULT_CONFIG.poll_interval_minutes,
		daily_cap: typeof raw.daily_cap === "number" ? raw.daily_cap : DEFAULT_CONFIG.daily_cap,
		dispatch: {
			capability:
				typeof dispatch.capability === "string"
					? dispatch.capability
					: DEFAULT_CONFIG.dispatch.capability,
			max_concurrent:
				typeof dispatch.max_concurrent === "number"
					? dispatch.max_concurrent
					: DEFAULT_CONFIG.dispatch.max_concurrent,
			monitor_interval_seconds:
				typeof dispatch.monitor_interval_seconds === "number"
					? dispatch.monitor_interval_seconds
					: DEFAULT_CONFIG.dispatch.monitor_interval_seconds,
			run_timeout_minutes:
				typeof dispatch.run_timeout_minutes === "number"
					? dispatch.run_timeout_minutes
					: DEFAULT_CONFIG.dispatch.run_timeout_minutes,
		},
		shipping: {
			auto_push:
				typeof shipping.auto_push === "boolean"
					? shipping.auto_push
					: DEFAULT_CONFIG.shipping.auto_push,
			pr_template:
				typeof shipping.pr_template === "string"
					? shipping.pr_template
					: DEFAULT_CONFIG.shipping.pr_template,
		},
	};
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function loadConfig(configPath?: string): Promise<DaemonConfig> {
	const path = configPath ?? join(GREENHOUSE_DIR, CONFIG_FILE);
	const file = Bun.file(path);
	if (!(await file.exists())) {
		throw new Error(`Config file not found: ${path}. Run \`grhs init\` to create one.`);
	}
	const content = await file.text();
	const raw = parseYaml(content);
	return validateConfig(raw);
}

export function defaultConfigPath(projectRoot?: string): string {
	return join(projectRoot ?? ".", GREENHOUSE_DIR, CONFIG_FILE);
}
