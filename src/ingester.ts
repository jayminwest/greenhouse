import { defaultExec } from "./exec.ts";
import type { ExecFn, GhIssue, RepoConfig, SdCreateResult } from "./types.ts";

/**
 * Map GitHub issue labels to seeds fields.
 */
function mapLabels(labels: string[]): {
	type: "task" | "bug" | "feature";
	priority: number;
	areaPrefix: string;
	difficultySuffix: string;
} {
	let type: "task" | "bug" | "feature" = "task";
	let priority = 2;
	let areaPrefix = "";
	let difficultySuffix = "";

	for (const label of labels) {
		if (label === "type:bug") {
			type = "bug";
		} else if (label === "type:feature") {
			type = "feature";
		} else if (label === "type:task") {
			type = "task";
		} else if (label.startsWith("priority:P")) {
			const n = Number.parseInt(label.slice("priority:P".length), 10);
			if (!Number.isNaN(n) && n >= 0 && n <= 4) {
				priority = n;
			}
		} else if (label.startsWith("area:")) {
			const area = label.slice("area:".length);
			areaPrefix = `[${area}] `;
		} else if (label.startsWith("difficulty:")) {
			const difficulty = label.slice("difficulty:".length);
			difficultySuffix = ` (${difficulty})`;
		}
	}

	return { type, priority, areaPrefix, difficultySuffix };
}

/**
 * Convert a GitHub issue to a seeds issue.
 * Returns the seeds issue ID.
 */
export async function ingestIssue(
	issue: GhIssue,
	repo: RepoConfig,
	exec: ExecFn = defaultExec,
): Promise<{ seedsId: string }> {
	const labelNames = issue.labels.map((l) => l.name);
	const { type, priority, areaPrefix, difficultySuffix } = mapLabels(labelNames);

	const description = `${areaPrefix}From GitHub issue #${issue.number}\n\n${issue.body}${difficultySuffix}`;

	const { exitCode, stdout, stderr } = await exec(
		[
			"sd",
			"create",
			"--title",
			issue.title,
			"--type",
			type,
			"--priority",
			String(priority),
			"--description",
			description,
			"--json",
		],
		{ cwd: repo.project_root },
	);

	if (exitCode !== 0) {
		throw new Error(`sd create failed: ${stderr.trim()}`);
	}

	const result = JSON.parse(stdout) as SdCreateResult;
	return { seedsId: result.id };
}

export { mapLabels };
