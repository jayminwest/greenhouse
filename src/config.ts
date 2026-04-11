import { homedir } from "node:os";
import { join } from "node:path";
import type { DaemonConfig, RepoConfig } from "./types.ts";
import { CONFIG_FILE, GREENHOUSE_DIR } from "./types.ts";

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
	clone_root: join(homedir(), ".greenhouse", "runs"),
	poll_interval_minutes: 10,
	run_timeout_minutes: 90,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Expand a leading ~ to the user's home directory. */
function expandHome(p: string): string {
	if (p === "~" || p.startsWith("~/")) {
		return join(homedir(), p.slice(2));
	}
	return p;
}

// ─── Validation ───────────────────────────────────────────────────────────────

/** Legacy top-level fields removed in v0.2.0. */
const LEGACY_TOP_FIELDS = ["daily_cap", "dispatch", "shipping"] as const;

/** Legacy per-repo fields removed in v0.2.0. */
const LEGACY_REPO_FIELDS = ["labels", "project_root"] as const;

function isRepoConfig(r: unknown): r is RepoConfig {
	if (!r || typeof r !== "object") return false;
	const obj = r as Record<string, unknown>;
	return (
		typeof obj.owner === "string" &&
		typeof obj.repo === "string" &&
		typeof obj.ready_label === "string"
	);
}

function validateConfig(raw: Record<string, unknown>): DaemonConfig {
	// Reject legacy top-level fields
	for (const field of LEGACY_TOP_FIELDS) {
		if (field in raw) {
			throw new Error(
				`config.yaml: \`${field}\` was removed in v0.2.0. Remove it from your config.`,
			);
		}
	}

	if (!Array.isArray(raw.repos) || raw.repos.length === 0) {
		throw new Error("config.yaml: `repos` is required and must be a non-empty array");
	}

	for (const r of raw.repos) {
		if (!r || typeof r !== "object") {
			throw new Error(
				"config.yaml: each repo must have owner, repo (strings) and ready_label (string)",
			);
		}
		const obj = r as Record<string, unknown>;
		// Reject legacy per-repo fields
		for (const field of LEGACY_REPO_FIELDS) {
			if (field in obj) {
				throw new Error(
					`config.yaml: repo field \`${field}\` was removed in v0.2.0. Remove it from your config.`,
				);
			}
		}
		if (!isRepoConfig(r)) {
			throw new Error(
				"config.yaml: each repo must have owner, repo (strings) and ready_label (string)",
			);
		}
	}

	const repos = raw.repos as RepoConfig[];
	const version = typeof raw.version === "string" ? raw.version : "1";

	const rawCloneRoot =
		typeof raw.clone_root === "string" ? raw.clone_root : DEFAULT_CONFIG.clone_root;

	return {
		version,
		repos,
		clone_root: expandHome(rawCloneRoot),
		poll_interval_minutes:
			typeof raw.poll_interval_minutes === "number"
				? raw.poll_interval_minutes
				: DEFAULT_CONFIG.poll_interval_minutes,
		run_timeout_minutes:
			typeof raw.run_timeout_minutes === "number"
				? raw.run_timeout_minutes
				: DEFAULT_CONFIG.run_timeout_minutes,
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
