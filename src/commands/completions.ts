/**
 * grhs completions <shell> — Generate shell completion scripts
 */

import type { Command } from "commander";

const SUPPORTED_SHELLS = ["bash", "zsh", "fish"] as const;
type Shell = (typeof SUPPORTED_SHELLS)[number];

interface CmdInfo {
	name: string;
	description: string;
	options: { flags: string; description: string }[];
	subcommands: { name: string; description: string }[];
}

function collectCommands(program: Command): CmdInfo[] {
	const result: CmdInfo[] = [];
	for (const cmd of program.commands) {
		const info: CmdInfo = {
			name: cmd.name(),
			description: cmd.description(),
			options: cmd.options.map((o) => ({
				flags: o.long ?? o.short ?? o.flags,
				description: o.description,
			})),
			subcommands: [],
		};
		for (const sub of cmd.commands) {
			info.subcommands.push({ name: sub.name(), description: sub.description() });
		}
		result.push(info);
	}
	return result;
}

function generateBash(program: Command): string {
	const cmds = collectCommands(program);
	const cmdNames = cmds.map((c) => c.name).join(" ");

	const subcompletions = cmds
		.filter((c) => c.subcommands.length > 0)
		.map((c) => {
			const subs = c.subcommands.map((s) => s.name).join(" ");
			return `    ${c.name})\n      COMPREPLY=($(compgen -W "${subs}" -- "\${cur}"))\n      return\n      ;;`;
		})
		.join("\n");

	return `# grhs bash completion
# Add to ~/.bashrc: eval "$(grhs completions bash)"
_grhs_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local prev="\${COMP_WORDS[COMP_CWORD-1]}"
  local commands="${cmdNames}"

  case "\${prev}" in
${subcompletions || "    *);;"}
  esac

  COMPREPLY=($(compgen -W "\${commands}" -- "\${cur}"))
}

complete -F _grhs_completions grhs
complete -F _grhs_completions greenhouse
`;
}

function generateZsh(program: Command): string {
	const cmds = collectCommands(program);
	const commandLines = cmds
		.map((c) => {
			const desc = c.description.replace(/'/g, "\\'");
			return `    '${c.name}:${desc}'`;
		})
		.join("\n");

	return `#compdef grhs greenhouse
# grhs zsh completion
# Add to ~/.zshrc: eval "$(grhs completions zsh)"
_grhs() {
  local -a commands
  commands=(
${commandLines}
  )
  _describe 'command' commands
}

_grhs "$@"
`;
}

function generateFish(program: Command): string {
	const cmds = collectCommands(program);
	const lines = cmds
		.map((c) => {
			const desc = c.description.replace(/'/g, "\\'");
			const line = `complete -c grhs -f -n '__fish_use_subcommand' -a '${c.name}' -d '${desc}'`;
			const subLines = c.subcommands
				.map(
					(s) =>
						`complete -c grhs -f -n '__fish_seen_subcommand_from ${c.name}' -a '${s.name}' -d '${s.description.replace(/'/g, "\\'")}'`,
				)
				.join("\n");
			return subLines ? `${line}\n${subLines}` : line;
		})
		.join("\n");

	return `# grhs fish completion
# Add to config.fish: grhs completions fish | source
${lines}
`;
}

export function registerCompletionsCommand(program: Command): void {
	program
		.command("completions")
		.argument("<shell>", `Shell type (${SUPPORTED_SHELLS.join(", ")})`)
		.description("Output shell completion script")
		.action((shell: string) => {
			if (!SUPPORTED_SHELLS.includes(shell as Shell)) {
				process.stderr.write(
					`Unknown shell: ${shell}. Supported: ${SUPPORTED_SHELLS.join(", ")}\n`,
				);
				process.exitCode = 1;
				return;
			}
			switch (shell as Shell) {
				case "bash":
					process.stdout.write(generateBash(program));
					break;
				case "zsh":
					process.stdout.write(generateZsh(program));
					break;
				case "fish":
					process.stdout.write(generateFish(program));
					break;
			}
		});
}
