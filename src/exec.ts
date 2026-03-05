import type { ExecFn, ExecResult } from "./types.ts";

/**
 * Default subprocess executor using Bun.spawn.
 */
export const defaultExec: ExecFn = async (
	cmd: string[],
	opts?: { cwd?: string },
): Promise<ExecResult> => {
	const proc = Bun.spawn(cmd, {
		cwd: opts?.cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();

	return { exitCode, stdout, stderr };
};
