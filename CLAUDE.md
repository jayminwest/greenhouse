# Greenhouse

Autonomous development daemon that closes the last manual loop in the os-eco ecosystem. Greenhouse polls GitHub for triaged issues, creates seeds tasks, dispatches overstory agent runs, monitors completion, merges results, and opens pull requests — all without human intervention.

## Tech Stack

- **Runtime:** Bun (runs TypeScript directly, no build step)
- **Language:** TypeScript with strict mode (`noUncheckedIndexedAccess`, no `any`)
- **Linting:** Biome (formatter + linter in one tool)
- **Runtime dependencies:** `chalk` (color output), `commander` (CLI framework)
- **CLI framework:** Commander.js (typed options, subcommands)
- **Dev dependencies:** `@types/bun`, `typescript`, `@biomejs/biome`
- **External CLIs (not npm deps):** `ov` (overstory), `sd` (seeds), `gh` (GitHub CLI), `git`

## Architecture

### Daemon Pipeline

Greenhouse runs a continuous poll-dispatch-monitor-ship loop:

```
GitHub Issues → Poller → Ingester → Dispatcher → Monitor → Shipper → GitHub PR
       ↓            ↓          ↓           ↓          ↓          ↓
   gh issue     filter by   sd create   ov sling   ov status   git push
     list       labels                              check     gh pr create
```

1. **Poller** (`src/poller.ts`) — fetches open GitHub issues filtered by configured labels via `gh issue list`
2. **Ingester** (`src/ingester.ts`) — maps GitHub issue metadata (labels, priority, type) to a seeds task via `sd create`
3. **Dispatcher** (`src/dispatcher.ts`) — creates a greenhouse merge branch, then spawns an overstory lead agent via `ov sling`
4. **Monitor** (`src/monitor.ts`) — polls `ov status --json` to detect agent completion or zombie state
5. **Shipper** (`src/shipper.ts`) — pushes the merge branch, creates a GitHub PR via `gh pr create`, and comments on the original issue
6. **Daemon** (`src/daemon.ts`) — orchestrates the full cycle: monitor active runs → poll new issues → ingest → dispatch → ship. Handles SIGINT/SIGTERM for graceful shutdown and SIGHUP for config reload.

### State Management

- **JSONL state** (`src/state.ts`) — append-only log at `.greenhouse/state.jsonl`, keyed by `(ghRepo, ghIssueId)`. Dedup-on-read (last entry wins). Tracks full run lifecycle: `pending → ingested → running → shipping → shipped` or `failed`.
- **PID file** (`src/pid.ts`) — daemon process tracking at `.greenhouse/daemon.pid`
- **Budget** (`src/budget.ts`) — in-memory daily dispatch cap with midnight reset. Prevents runaway spending.

### Run Lifecycle

```
pending → ingested → running → shipping → shipped
                         ↓         ↓
                       failed    failed
```

Each `RunState` tracks: GitHub source (issue, repo, labels), seeds mapping (task ID), overstory state (agent name, branch, merge branch), shipping result (PR URL/number), and timestamps for each transition.

## Directory Structure

```
greenhouse/
  src/
    cli.ts                    # CLI entry point (Commander.js, VERSION constant)
    types.ts                  # All shared types and interfaces
    config.ts                 # YAML config parser + validation + defaults
    daemon.ts                 # Main daemon loop (poll → dispatch → monitor → ship)
    poller.ts                 # GitHub issue polling via gh CLI
    ingester.ts               # GitHub → seeds issue mapping
    dispatcher.ts             # Overstory agent dispatch via ov sling
    monitor.ts                # Agent completion detection via ov status
    shipper.ts                # Branch push + PR creation via gh/git
    state.ts                  # JSONL run state (append-only, dedup-on-read)
    budget.ts                 # Daily dispatch budget tracker
    pid.ts                    # Daemon PID file management
    exec.ts                   # Subprocess executor (Bun.spawn wrapper)
    output.ts                 # Console output helpers (JSON mode, colors)
    commands/
      init.ts                 # grhs init
      start.ts                # grhs start (launch daemon)
      stop.ts                 # grhs stop (signal daemon)
      status.ts               # grhs status
      config.ts               # grhs config show
      doctor.ts               # grhs doctor
      poll.ts                 # grhs poll (manual one-shot)
      ingest.ts               # grhs ingest (manual one-shot)
      ship.ts                 # grhs ship (manual one-shot)
      runs.ts                 # grhs runs list/show/retry
      logs.ts                 # grhs logs
      budget.ts               # grhs budget
```

### What `grhs init` creates

```
.greenhouse/
  config.yaml                 # Daemon configuration (repos, labels, limits)
  state.jsonl                 # Run state log (gitignored)
  daemon.pid                  # PID file (gitignored)
  daemon.log                  # Log output (gitignored)
```

## Build & Test Commands

```bash
bun test              # Run all tests
bun run lint          # biome check .
bun run lint:fix      # biome check --write .
bun run typecheck     # tsc --noEmit
```

Quality gate before finishing work: `bun test && bun run lint && bun run typecheck`

## CLI Command Reference

Binary names: `greenhouse` / `grhs`

```
grhs init                          Initialize .greenhouse/ with config.yaml
grhs start                         Start the daemon (background process)
grhs stop                          Stop the daemon (SIGTERM)
grhs status                        Show daemon status + active runs
grhs config show                   Display current configuration
grhs doctor                        Run health checks

grhs poll                          Manual one-shot poll cycle
grhs ingest <issue-number>         Manual ingest of a GitHub issue
grhs ship <seeds-id>               Manual ship of a completed run

grhs runs list                     List all tracked runs
grhs runs show <id>                Show run details
grhs runs retry <id>               Retry a failed run

grhs logs                          Show daemon logs
grhs budget                        Show daily dispatch budget

Global flags:
  --json                           JSON output
  --config <path>                  Config file path
```

## Coding Conventions

### Formatting

- **Tab indentation** (enforced by Biome)
- **100 character line width** (enforced by Biome)

### TypeScript

- Strict mode with `noUncheckedIndexedAccess` — always handle possible `undefined` from indexing
- `noExplicitAny` is an error — use `unknown` and narrow, or define proper types
- `useConst` is enforced — use `const` unless reassignment is needed
- All shared types go in `src/types.ts`
- All imports use `.ts` extensions

### Dependencies

- **Minimal runtime dependencies.** Only `chalk` and `commander`.
- Use Bun built-in APIs: `Bun.spawn` for subprocesses, `Bun.file`/`Bun.write` for file I/O
- External tools (`ov`, `sd`, `gh`, `git`) are invoked as subprocesses via the `ExecFn` interface (`src/exec.ts`)
- All subprocess calls are injectable via `ExecFn` for testability

### Subprocess Pattern

All external commands go through the `ExecFn` interface for testability:

```typescript
export type ExecFn = (cmd: string[], opts?: { cwd?: string }) => Promise<ExecResult>;
```

Production uses `defaultExec` (Bun.spawn). Tests inject mock executors.

### File Organization

- Each CLI command gets its own file in `src/commands/`
- Core pipeline modules at `src/` root (poller, ingester, dispatcher, monitor, shipper)
- Tests colocated: `src/foo.test.ts` next to `src/foo.ts`

## Testing

- **Framework:** `bun test` (built-in, Jest-compatible API)
- **Test location:** Tests colocated with source files
- **Pattern:** Inject mock `ExecFn` to test pipeline stages without real subprocesses
- Tests use real filesystem (temp dirs via `mkdtemp`) for state management tests

## Configuration

YAML config at `.greenhouse/config.yaml`:

```yaml
version: "1"
repos:
  - owner: jayminwest
    repo: mulch
    labels:
      - "status:triaged"
    project_root: /path/to/mulch
poll_interval_minutes: 10
daily_cap: 5
dispatch:
  capability: lead
  max_concurrent: 2
  monitor_interval_seconds: 30
  run_timeout_minutes: 60
shipping:
  auto_push: true
```

## Version Management

Version lives in two locations:
- `package.json` — `"version"` field
- `src/cli.ts` — `const VERSION = "X.Y.Z"`

Bump via: `bun scripts/version-bump.ts <major|minor|patch>`

<!-- mulch:start -->
## Project Expertise (Mulch)
<!-- mulch-onboard-v:1 -->

This project uses [Mulch](https://github.com/jayminwest/mulch) for structured expertise management.

**At the start of every session**, run:
```bash
mulch prime
```

This injects project-specific conventions, patterns, decisions, and other learnings into your context.
Use `mulch prime --files src/foo.ts` to load only records relevant to specific files.

**Before completing your task**, review your work for insights worth preserving — conventions discovered,
patterns applied, failures encountered, or decisions made — and record them:
```bash
mulch record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
```

Link evidence when available: `--evidence-commit <sha>`, `--evidence-bead <id>`

Run `mulch status` to check domain health and entry counts.
Run `mulch --help` for full usage.
Mulch write commands use file locking and atomic writes — multiple agents can safely record to the same domain concurrently.

### Before You Finish

1. Discover what to record:
   ```bash
   mulch learn
   ```
2. Store insights from this work session:
   ```bash
   mulch record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
   ```
3. Validate and commit:
   ```bash
   mulch sync
   ```
<!-- mulch:end -->

<!-- canopy:start -->
## Prompt Management (Canopy)
<!-- canopy-onboard-v:1 -->

This project uses [Canopy](https://github.com/jayminwest/canopy) for git-native prompt management.

**At the start of every session**, run:
```
cn prime
```

This injects prompt workflow context: commands, conventions, and common workflows.

**Quick reference:**
- `cn list` — List all prompts
- `cn render <name>` — View rendered prompt (resolves inheritance)
- `cn emit --all` — Render prompts to files
- `cn update <name>` — Update a prompt (creates new version)
- `cn sync` — Stage and commit .canopy/ changes

**Do not manually edit emitted files.** Use `cn update` to modify prompts, then `cn emit` to regenerate.
<!-- canopy:end -->

<!-- seeds:start -->
## Issue Tracking (Seeds)
<!-- seeds-onboard-v:1 -->

This project uses [Seeds](https://github.com/jayminwest/seeds) for git-native issue tracking.

**At the start of every session**, run:
```
sd prime
```

This injects session context: rules, command reference, and workflows.

**Quick reference:**
- `sd ready` — Find unblocked work
- `sd create --title "..." --type task --priority 2` — Create issue
- `sd update <id> --status in_progress` — Claim work
- `sd close <id>` — Complete work
- `sd dep add <id> <depends-on>` — Add dependency between issues
- `sd sync` — Sync with git (run before pushing)

### Before You Finish
1. Close completed issues: `sd close <id>`
2. File issues for remaining work: `sd create --title "..."`
3. Sync and push: `sd sync && git push`
<!-- seeds:end -->
