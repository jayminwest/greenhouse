# Greenhouse — V1 Scope

## One-Liner
Autonomous development daemon that polls GitHub for triaged issues, dispatches overstory agent runs, monitors completion, and opens pull requests — closing the last manual loop.

## V1 Definition of Done

### CLI Commands
- [x] grhs init creates .greenhouse/ with valid default config
- [x] grhs start runs the daemon loop (foreground and --detach mode)
- [x] grhs stop terminates a detached daemon cleanly via SIGTERM (supports --force for SIGKILL)
- [x] grhs status shows daemon state, active runs, and budget
- [x] grhs poll executes a manual one-shot poll cycle against GitHub (supports --dry-run and --no-dispatch)
- [x] grhs ingest <gh-issue-url> manually ingests a single GitHub issue into seeds
- [x] grhs runs lists tracked runs with --status and --repo filters
- [x] grhs run show <gh-issue-id> shows detailed run state with timing breakdown
- [x] grhs run retry <gh-issue-id> retries a failed run (resets to pending, attempts re-dispatch)
- [x] grhs run cancel <gh-issue-id> cancels a pending or running run
- [x] grhs run clean compacts state.jsonl by removing terminal runs (added post-spec, not yet documented)
- [x] grhs doctor validates all prerequisites (gh auth, ov, sd, git, config, state)
- [x] grhs config show displays resolved configuration
- [x] grhs logs shows daemon logs with --follow tail mode and --since time filter
- [x] grhs budget shows daily dispatch cap status (supports --reset for emergency use)
- [ ] grhs ship <seeds-id> manually pushes and creates PR for a completed run — REMOVED in deprecation commit fc44890. Shipping mechanism needed (see Open Questions).

### Pipeline
- [x] Poll pipeline works: fetches GitHub issues by label via gh issue list --json, supports multiple repos
- [x] Ingest pipeline works: maps GitHub labels to seeds fields (priority, type, area, difficulty), creates seeds tasks via sd create --json, avoids duplicates via isIngested() check
- [x] Dispatch pipeline works: creates greenhouse merge branch (greenhouse/<seedsId>), writes session-branch.txt, ensures coordinator running, sends structured dispatch mail via ov coordinator send with full task spec
- [x] Supervisor spawned: tmux session with Claude Code, startup beacon, TUI readiness detection, trust dialog handling
- [x] Supervisor monitoring: daemon checks isSupervisorAlive() each poll cycle, detects exit and reads final state
- [x] Supervisor timeout: daemon-level failsafe kills supervisor after run_timeout_minutes (default 90m), marks run as failed+retryable
- [ ] End-to-end run completion (poll -> dispatch -> supervisor completes -> ship -> PR) — BLOCKED by shipping gap
- [ ] Fix supervisor prompt template variables (open bug greenhouse-04a7 — {{seeds_id}}, {{merge_branch}} unresolved in canopy prompt, stale references to removed CLI commands grhs ship and grhs runs update)

### Shipping (Blocked)
- [ ] Ship pipeline works: pushes merge branch, creates GitHub PR, links back to source issue
- [ ] greenhouse-0dbc resolved that agents should NEVER push to remote directly (closed as won't fix). The supervisor cannot ship. A new shipping mechanism is needed — either grhs ship as a guardrailed gateway the supervisor invokes, or the daemon itself ships when the supervisor exits successfully.

### Infrastructure
- [x] Daily budget cap prevents runaway dispatch (in-memory BudgetTracker + state-derived computeBudget())
- [x] State persistence (JSONL) tracks run lifecycle across daemon restarts (append-only with dedup-on-read)
- [x] SIGHUP reloads config without restart
- [x] PID file management for daemon lifecycle (write on start, remove on stop, stale detection)
- [x] Structured daemon logging (JSON to stderr with timestamps, levels, event fields)
- [x] Duration/timing utilities for run stage breakdown

### Quality
- [x] All 185 tests pass (bun test) — 0 failures, 325 assertions across 13 test files
- [x] TypeScript strict mode clean (bun run typecheck)
- [x] Linting passes (bun run lint — Biome, 38 files checked)
- [x] CI pipeline runs lint + typecheck + test on push/PR (.github/workflows/ci.yml)
- [x] Publish pipeline to npm with version sync verification (.github/workflows/publish.yml)
- [x] Published to npm as @os-eco/greenhouse-cli (v0.1.2)

## Explicitly Out of Scope for V1

- Multi-repo polling (V1 targets single repo — NOTE: code already supports repos[] array but untested in production with multiple repos)
- PR review automation (greenhouse opens PRs; humans review them)
- Cost tracking or spend limits per run
- Slack/Discord notifications on run completion or failure
- Web dashboard for monitoring daemon state
- Automatic issue triage or priority assignment
- Daemon-level automatic retry of failed runs (manual grhs run retry only — daemon retry cap pattern was designed but not wired in)
- Parallel dispatch (V1 processes issues sequentially within each poll cycle, but max_concurrent config exists and is enforced)
- Custom dispatch strategies or agent role selection
- Metrics collection or performance reporting
- Webhook-based triggering (polling only for V1)

## Current State

### Architecture
Greenhouse underwent a significant architectural shift. The original mechanical pipeline (poller -> ingester -> dispatcher -> monitor -> shipper) was partially replaced by a supervisor architecture: after dispatch, a Claude Code supervisor agent runs in a tmux session and takes ownership of the run through completion. The mechanical monitor, shipper, and cleanup modules were deprecated and removed in commit fc44890.

Current pipeline: Poll -> Ingest -> Dispatch+Supervisor -> (supervisor handles coordinator monitoring and completion detection)

Missing link: The supervisor cannot ship (remote branch operations are blocked by overstory hooks, per greenhouse-0dbc resolution). No shipping mechanism currently exists in the codebase. This is the primary V1 blocker.

### What Works
- All 16 CLI commands (see checklist above)
- Daemon lifecycle: foreground/detached modes, SIGINT/SIGTERM shutdown, SIGHUP config reload, PID tracking
- GitHub polling: fetches issues by label, supports --dry-run, avoids duplicate ingestion
- Issue ingestion: label mapping (priority, type, area, difficulty), seeds task creation
- Dispatch: merge branch creation, coordinator start, structured dispatch mail with full task spec
- Supervisor spawning: tmux session, Claude Code with model selection, TUI readiness polling, startup beacon
- Supervisor monitoring: daemon-level health checks, timeout+kill with process tree cleanup
- Budget tracking: daily cap, in-memory + state-derived, reset support
- State management: append-only JSONL, dedup-on-read, run lifecycle tracking
- Output system: JSON mode, quiet/verbose/timing flags, colored status icons, duration formatting

### What is Broken
1. Supervisor prompt (greenhouse-04a7, open): Canopy prompt has unresolved {{mustache}} variables and references removed commands (grhs ship, grhs runs update). Supervisor agents get confused about how to ship.
2. No shipping path: greenhouse-0dbc confirmed agents should never push to remote directly. The old shipper.ts was removed. No replacement exists. The supervisor has no way to create a PR.

### What is Missing
- Shipping mechanism: Either (a) rebuild grhs ship as a CLI command the supervisor can invoke (guardrailed, runs outside the agent sandbox), or (b) have the daemon detect supervisor completion and ship automatically
- End-to-end test: No integration test of the full pipeline from poll to PR
- Test coverage gaps: 13 modules have tests, but 11 modules lack dedicated test files (pid.ts, exec.ts, cli.ts, types.ts, and 7 command files: status, stop, logs, ingest, budget, config, start). Commands are partially covered via integration in other tests but edge cases are untested.

### Known Issues and Discrepancies

#### Documentation vs Code Mismatches
- CLAUDE.md still describes the old 6-stage pipeline architecture (poller -> ingester -> dispatcher -> monitor -> shipper) and references src/monitor.ts, src/shipper.ts, src/cleanup.ts — all removed
- CLAUDE.md lists dispatch.capability: lead in config example but code defaults to coordinator
- CLAUDE.md lists ship.ts in directory structure — file does not exist
- README.md How It Works section describes 6 stages including Monitor, Ship, Link — none of which exist as separate stages
- README.md says dispatch uses ov sling — code uses ov coordinator send
- README.md documents grhs ship <seeds-task-id> command — does not exist
- README.md omits grhs run clean, grhs run cancel, --dry-run, --no-dispatch, --follow, --since, --reset options
- CLAUDE.md says state.jsonl is gitignored — .greenhouse/.gitignore does NOT include state.jsonl
- grhs init generates a PR template with {github_issue_number}, {seeds_task_id}, {agent_summary} placeholders — no code exists to interpolate these

#### Code Quality Notes
- daemon.ts:311 — sleep log uses stale config.poll_interval_minutes instead of currentConfig.poll_interval_minutes (bug after SIGHUP reload)
- logs.ts:138 — followLog() uses recursive await poll() calls, which will cause a stack overflow for long-running follow sessions; should use a loop
- daemon.ts — BudgetTracker is constructed fresh each runPollCycle() call (line 121), so it resets to 0 on every cycle. The in-memory counter never actually accumulates. Budget enforcement works only because computeBudget() (state-derived) is used in commands. The daemon in-memory budget is effectively non-functional.
- commands/status.ts:40-47 — duplicates isProcessAlive() from pid.ts instead of importing it
- supervisor.ts:15 — SUPERVISOR_MODEL hardcoded to claude-sonnet-4-6; should be configurable via daemon config
- init.ts — uses sync fs APIs (mkdirSync, writeFileSync, existsSync) while rest of codebase uses async. Not a bug but inconsistent.
- commands/ingest.ts — dispatches immediately without checking budget; documented as bypasses daily cap but could be surprising

#### Test Gaps
Modules with tests (13): budget, config, daemon, dispatcher, ingester, output, poller, state, supervisor, commands/doctor, commands/init, commands/poll, commands/runs

Modules without tests (11): pid, exec, cli, types (reasonable — thin/type-only), commands/status, commands/stop, commands/logs, commands/ingest, commands/budget, commands/config, commands/start

Specific untested areas:
- SIGHUP config reload behavior in daemon
- --detach mode process spawning
- followLog() tail behavior
- grhs stop --force SIGKILL path
- grhs budget --reset state modification
- Error paths in most commands (config not found, invalid args)
- waitForSupervisorReady() timeout and trust dialog paths (tested via supervisor.test.ts but coverage is limited)

### Progress Assessment

Estimated completion: ~75%. Up from the previous 70% estimate — more infrastructure has landed (supervisor spawning, monitoring, timeouts, cleanup, grhs run clean), and greenhouse-0dbc is resolved (closed as won't-fix). But the shipping gap is now more clearly defined: the old shipper was removed, the supervisor cannot push to remote, and no replacement exists. Once shipping is solved and the supervisor prompt is fixed (greenhouse-04a7), only an end-to-end integration test remains.

## Open Questions

1. Shipping mechanism: Should grhs ship be rebuilt as a CLI command the supervisor invokes via Bash tool (guardrailed, outside agent sandbox)? Or should the daemon detect supervisor completion and ship automatically? The latter is simpler but removes the supervisor ability to customize the PR.

2. Supervisor prompt: Should canopy own {{mustache}} variable interpolation, or should greenhouse resolve variables before injecting the prompt? Current approach uses --append-system-prompt with a spec file — the spec file already contains resolved values, so the canopy prompt may be unnecessary if the spec is sufficient.

3. Supervisor vs direct coordinator dispatch: Is the supervisor layer (single Claude Code agent managing the whole run) the right model? The supervisor adds complexity (tmux management, TUI readiness detection, beacon protocol). Alternative: greenhouse dispatches to the coordinator and monitors completion directly via sd show — when the seeds issue closes, greenhouse ships.

4. Daily cap default: Current default is 5 issues/day. Is that right for V1?

5. Manual approval: Should there be a grhs approve <issue> step before dispatch, or is label-based triage on GitHub sufficient?

6. Multi-repo: Code supports repos[] array but V1 out-of-scope says single repo. Should multi-repo be documented as supported or explicitly disabled?

7. Budget persistence: The daemon in-memory BudgetTracker resets every poll cycle (reconstructed from scratch). Budget is only correctly computed via getDailyBudget() which reads state. Should the daemon use the state-derived budget instead?

8. State gitignore: Should state.jsonl be gitignored? CLAUDE.md says yes, .greenhouse/.gitignore says no. State contains per-instance run data that probably should not be committed.
