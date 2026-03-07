# Greenhouse — V1 Scope

## One-Liner
Autonomous development daemon that polls GitHub for triaged issues, dispatches overstory agent runs, monitors completion, and opens pull requests — closing the last manual loop.

## V1 Definition of Done

- [ ] `grhs init` creates `.greenhouse/` with valid default config
- [ ] `grhs start` runs the daemon loop (foreground and `--detach` mode)
- [ ] `grhs stop` terminates a detached daemon cleanly via SIGTERM
- [ ] `grhs status` shows daemon state, active runs, and budget
- [ ] `grhs poll` executes a manual one-shot poll cycle against GitHub
- [ ] `grhs ingest <issue>` manually ingests a single GitHub issue into seeds
- [ ] `grhs runs list/show/retry/cancel` manages tracked runs
- [ ] `grhs doctor` validates all prerequisites (gh auth, ov, sd, git, config)
- [ ] `grhs config show` displays resolved configuration
- [ ] `grhs logs` shows daemon logs with `--follow` tail mode
- [ ] `grhs budget` shows daily dispatch cap status
- [ ] Poll-ingest pipeline works: fetches GitHub issues by label, creates seeds tasks, avoids duplicates
- [ ] Dispatch pipeline works: spawns overstory coordinator, sends dispatch mail with task spec
- [ ] Supervisor monitors coordinator completion and detects when seeds task is closed
- [ ] Ship pipeline works: pushes merge branch, creates GitHub PR, links back to source issue
- [ ] Fix supervisor prompt template variables (open bug `greenhouse-04a7` — `{{seeds_id}}`, `{{merge_branch}}` unresolved)
- [ ] `grhs ship <seeds-id>` is the guardrailed shipping gateway — agents never run `git push` directly (overstory hooks stay in place)
- [ ] `grhs ship` pre-flight checks: no orphaned worktrees, tests pass, lint clean, typecheck clean, no stale locks
- [ ] `grhs ship` pushes merge branch and opens PR only after all pre-flights pass
- [ ] Supervisor prompt updated to call `grhs ship` instead of raw git push (resolves `greenhouse-0dbc`)
- [ ] Daily budget cap prevents runaway dispatch
- [ ] State persistence (JSONL) tracks run lifecycle across daemon restarts
- [ ] SIGHUP reloads config without restart
- [ ] All tests pass (`bun test`) — fix the 1 stale model assertion in supervisor.test.ts
- [ ] TypeScript strict mode clean (`bun run typecheck`)
- [ ] Linting passes (`bun run lint`)
- [ ] CI pipeline runs lint + typecheck + test on push/PR
- [ ] Published to npm as `@os-eco/greenhouse-cli`

## Explicitly Out of Scope for V1

- Multi-repo polling (V1 targets a single configured repo)
- PR review automation (greenhouse opens PRs; humans review them)
- Cost tracking or spend limits per run
- Slack/Discord notifications on run completion or failure
- Web dashboard for monitoring daemon state
- Automatic issue triage or priority assignment
- Retry policies beyond manual `grhs runs retry`
- Parallel dispatch (V1 processes one issue at a time)
- Custom dispatch strategies or agent role selection
- Metrics collection or performance reporting
- Webhook-based triggering (polling only for V1)

## Current State

Greenhouse has solid infrastructure (config, state, budget, CLI, daemon loop) but the end-to-end pipeline is blocked by two critical bugs:

1. **`greenhouse-04a7` (P2):** Supervisor prompt has unresolved template variables (`{{seeds_id}}`, `{{merge_branch}}`) and references removed CLI commands (`grhs ship`). Supervisor agents get stuck trying to figure out how to ship.

2. **`greenhouse-0dbc` (P1):** Overstory hooks unconditionally block `git push`, preventing the supervisor from shipping PRs to GitHub.

**What works:** All CLI commands, daemon lifecycle, GitHub polling, issue ingestion, seeds task creation, supervisor tmux spawning, budget tracking, state persistence, health checks.
**What's broken:** Supervisor cannot complete runs due to bad prompt and blocked git push.
**What's missing:** End-to-end run completion (poll → dispatch → ship → PR).

184 of 185 tests pass. The 1 failure is a stale model assertion (expects Sonnet, code uses Opus). Lint and typecheck are clean.

**Estimated completion: ~70%.** The infrastructure is solid but the two blocking bugs prevent the core value proposition from working. Once those are fixed, an end-to-end test of the full pipeline is needed.

## Open Questions

- Should canopy own template variable interpolation (`{{var}}` substitution), or should greenhouse resolve variables before injecting the prompt?
- ~~Should the supervisor be allowed to `git push` directly?~~ Resolved: No. `grhs ship` is the guardrailed shipping gateway. Overstory hooks continue to block raw `git push`. The supervisor calls `grhs ship <seeds-id>` which runs pre-flight checks before pushing.
- Is the supervisor-based architecture (single Claude Code agent manages the whole run) the right model, or should greenhouse dispatch directly to the coordinator without a supervisor?
- What's the intended daily cap for V1? Current default is 5 issues/day — is that right?
- Should there be a manual approval step before dispatch (e.g., `grhs approve <issue>`), or is label-based triage on GitHub sufficient?
