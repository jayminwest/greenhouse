# Greenhouse

Autonomous development daemon for AI agent workflows. Polls GitHub for triaged issues, dispatches overstory runs, and opens PRs — removing the human from the implementation loop.

Where seeds grow themselves.

## Why

The os-eco toolchain can already orchestrate multi-agent teams (overstory), track work (seeds), store expertise (mulch), and manage prompts (canopy). But every run still requires a human to:

1. **Find work** — scan GitHub issues, decide what's ready
2. **Translate** — manually create seeds issues from GitHub issues
3. **Dispatch** — run `ov sling` to kick off a coordinator
4. **Ship** — push branches and open PRs when agents finish
5. **Close the loop** — update GitHub issues with results

Greenhouse closes this gap. It's the missing feedback loop that turns a toolchain into an autonomous development system. A cron-based daemon polls GitHub for pre-triaged issues, converts them to seeds, dispatches overstory runs, and opens PRs when work completes. The only human touchpoint is merging the PR.

## Design Principles

1. **Standalone package.** Greenhouse is `@os-eco/greenhouse-cli`, not embedded in overstory. It's an opinionated automation layer on top of the ecosystem, not a core primitive. Users who don't want autonomous operation never see it.
2. **Shell out, don't import.** Greenhouse calls ecosystem tools via CLI (`ov`, `sd`, `gh`) rather than importing their internals. This keeps it decoupled and version-tolerant — any tool can evolve independently.
3. **GitHub CLI as the API layer.** Use `gh` (GitHub CLI) for all GitHub operations — issue listing, PR creation, commenting. No raw HTTP, no OAuth token management, no REST/GraphQL. `gh` handles auth, pagination, and rate limiting.
4. **Cron over webhooks.** Poll on a configurable interval rather than requiring inbound networking. Simpler to deploy (no tunnels, no public endpoints), works on home servers, and a 5-minute poll interval is fast enough for async development work.
5. **Idempotent everything.** Every poll cycle must be safe to re-run. If an issue was already ingested, skip it. If a run is already in progress, don't double-dispatch. If a PR already exists, don't create a duplicate.
6. **Daily cap as cost control.** Configurable limit on issues processed per day. The daemon stops dispatching after hitting the cap and resumes the next day. Simple, predictable, no surprise bills.
7. **PR as the human gate.** Greenhouse never pushes to the canonical branch. Every completed run produces a PR. The human reviews and merges at their leisure. Clean audit trail, full control.
8. **Observable.** Every action logged. Dashboard shows current state, recent runs, pending issues, daily budget remaining. Failures surface clearly — no silent drops.

## Architecture

### Core Loop

```
┌─────────────────────────────────────────┐
│           Greenhouse Daemon             │
│         (polls every N minutes)         │
├─────────────────────────────────────────┤
│                                         │
│  1. POLL     gh issue list --label ...  │
│  2. FILTER   skip ingested, skip WIP    │
│  3. INGEST   sd create (from GH issue)  │
│  4. DISPATCH ov sling <task-id>         │
│  5. MONITOR  ov status (poll for done)  │
│  6. SHIP     git push + gh pr create    │
│  7. LINK     comment on GH issue w/ PR  │
│  8. CLOSE    sd close <task-id>         │
│  9. SLEEP    wait for next interval     │
│                                         │
└─────────────────────────────────────────┘
```

### Concurrency Model

The daemon maintains up to `max_concurrent` runs simultaneously. Each poll cycle:

1. **Monitor first** — check all active runs (`running` or `shipping` status) for completion. Advance any that finished to the next state.
2. **Dispatch second** — only dispatch new issues if active run count is below `max_concurrent` and daily budget allows.
3. **Sleep** — wait for `poll_interval_minutes` before the next cycle.

No thread-level parallelism. Monitoring and dispatching use sequential async/await within each cycle. The `monitor_interval_seconds` config controls how often the daemon checks `ov status` for active runs *between* poll cycles (a tighter inner loop while runs are active).

### State Machine (Per Issue)

```
                 ┌──────────┐
  GH issue  ──> │ PENDING  │  (discovered, not yet dispatched)
  discovered    └────┬─────┘
                     │ daily cap check passes
                     v
                ┌──────────┐
                │ INGESTED │  (seeds issue created)
                └────┬─────┘
                     │ ov sling succeeds
                     v
                ┌──────────┐
                │ RUNNING  │  (overstory run in progress)
                └────┬─────┘
                     │ agents complete
                     v
                ┌──────────┐
                │ SHIPPING │  (pushing branch, creating PR)
                └────┬─────┘
                     │ PR created
                     v
                ┌──────────┐
                │ SHIPPED  │  (PR open, awaiting human merge)
                └──────────┘

  Error at any stage ──> FAILED (with reason, retryable flag)
```

### Component Overview

```
greenhouse/
  src/
    daemon.ts          # Main loop: poll → filter → dispatch → monitor → ship
    poller.ts          # GitHub issue fetcher (gh CLI wrapper)
    ingester.ts        # GH issue → seeds issue converter
    dispatcher.ts      # Overstory run launcher (ov sling wrapper)
    monitor.ts         # Run completion watcher (ov status poller)
    shipper.ts         # Branch pusher + PR creator (git + gh CLI)
    state.ts           # Run state persistence (JSONL)
    config.ts          # YAML config loader
    budget.ts          # Daily cap tracker
    cli.ts             # CLI entry point
    types.ts           # Shared types and interfaces
```

## On-Disk Format

```
.greenhouse/
  config.yaml          # Daemon configuration
  state.jsonl          # Run state (one entry per tracked GH issue)
  .gitignore           # Ignores lock files, local overrides
```

### config.yaml

```yaml
version: "1"

# Repos to watch (start with one, add more later)
repos:
  - owner: jayminwest
    repo: overstory
    labels:
      - agent-ready
    project_root: /Users/jayminwest/Projects/os-eco/overstory

# Polling
poll_interval_minutes: 10

# Cost control
daily_cap: 5

# Overstory dispatch
dispatch:
  capability: coordinator
  max_concurrent: 2
  monitor_interval_seconds: 30
  run_timeout_minutes: 60

# Shipping
shipping:
  auto_push: true
  pr_template: |
    ## Greenhouse Auto-PR

    **GitHub Issue:** #{github_issue_number}
    **Seeds Task:** {seeds_task_id}

    ### Summary
    {agent_summary}

    ### Quality Gates
    - [ ] Tests pass
    - [ ] Lint clean
    - [ ] Typecheck clean

    ---
    Automated by [Greenhouse](https://github.com/jayminwest/greenhouse)
```

### state.jsonl

One line per tracked GitHub issue. Append-only with dedup-on-read (same pattern as seeds).

```jsonl
{"ghIssueId":42,"ghRepo":"jayminwest/overstory","seedsId":"overstory-a1b2","status":"shipped","prUrl":"https://github.com/jayminwest/overstory/pull/99","dispatchedAt":"2026-03-05T10:00:00Z","shippedAt":"2026-03-05T10:45:00Z","updatedAt":"2026-03-05T10:45:00Z"}
{"ghIssueId":43,"ghRepo":"jayminwest/overstory","seedsId":"overstory-c3d4","status":"running","dispatchedAt":"2026-03-05T10:05:00Z","updatedAt":"2026-03-05T10:05:00Z"}
```

## Data Model

### RunState

```typescript
interface RunState {
  // GitHub source
  ghIssueId: number;           // GitHub issue number
  ghRepo: string;              // "owner/repo"
  ghTitle: string;             // Issue title (for display)
  ghLabels: string[];          // Labels at time of ingestion

  // Seeds mapping
  seedsId: string;             // Seeds issue ID (e.g., "overstory-a1b2")

  // Lifecycle
  status: RunStatus;
  error?: string;              // Error message if FAILED
  retryable?: boolean;         // Whether this failure can be retried

  // Overstory
  agentName?: string;          // Coordinator agent name from ov sling
  branch?: string;             // Git branch name (e.g., "overstory/lead-42/overstory-a1b2")

  // Shipping
  prUrl?: string;              // GitHub PR URL
  prNumber?: number;           // GitHub PR number

  // Timestamps
  discoveredAt: string;        // ISO 8601 — when poller first saw it
  ingestedAt?: string;         // When seeds issue was created
  dispatchedAt?: string;       // When ov sling was called
  completedAt?: string;        // When agents finished
  shippedAt?: string;          // When PR was created
  updatedAt: string;           // Last state change
}

type RunStatus =
  | "pending"                  // Discovered, awaiting dispatch
  | "ingested"                 // Seeds issue created
  | "running"                  // Overstory run in progress
  | "shipping"                 // Pushing + creating PR
  | "shipped"                  // PR open, awaiting human merge
  | "failed";                  // Error (check error field)
```

### DaemonConfig

```typescript
interface RepoConfig {
  owner: string;               // GitHub org/user
  repo: string;                // Repository name
  labels: string[];            // Required labels for pickup (all must match)
  project_root: string;        // Absolute path to local clone
}

interface DaemonConfig {
  version: string;
  repos: RepoConfig[];              // REQUIRED — no default
  poll_interval_minutes: number;    // Default: 10
  daily_cap: number;                // Default: 5
  dispatch: {
    capability: string;             // Default: "coordinator"
    max_concurrent: number;         // Default: 2
    monitor_interval_seconds: number; // Default: 30
    run_timeout_minutes: number;    // Default: 60
  };
  shipping: {
    auto_push: boolean;             // Default: true
    pr_template: string;            // Default: built-in template (see config.yaml example above)
  };
}

// Only `repos` is required. All other fields are filled with defaults on load.
// A minimal valid config is:
//   version: "1"
//   repos:
//     - owner: jayminwest
//       repo: overstory
//       labels: [agent-ready]
//       project_root: /path/to/overstory
```

### DailyBudget

```typescript
interface DailyBudget {
  date: string;                // YYYY-MM-DD
  dispatched: number;          // Issues dispatched today
  cap: number;                 // From config
  remaining: number;           // cap - dispatched
}
```

## CLI

Binary name: `greenhouse` (full name).

Short alias: `grhs` (greenhouse).

Every command supports `--json` for structured output.

### Daemon Commands

```
grhs start                              Start the daemon (foreground)
  --detach                             Run in background (writes PID file)
  --config <path>                      Config file path (default: .greenhouse/config.yaml)

grhs stop                               Stop a detached daemon
  --force                              Kill immediately (SIGKILL vs SIGTERM)

grhs status                             Show daemon state
                                       Running/stopped, current runs, daily budget, next poll
```

### Run Management

```
grhs runs                               List all tracked runs
  --status <status>                    Filter by status
  --repo <owner/repo>                 Filter by repo
  --limit <n>                          Max results (default: 20)

grhs run show <gh-issue-id>             Show detailed run state

grhs run retry <gh-issue-id>            Retry a failed run

grhs run cancel <gh-issue-id>           Cancel a pending/running run
```

### Manual Operations

```
grhs poll                               Run one poll cycle (don't start daemon)
                                       Useful for testing and one-off runs

grhs ingest <gh-issue-url>              Manually ingest a single GitHub issue
                                       Bypasses label filter and daily cap

grhs ship <seeds-task-id>               Manually push + PR for a completed run
```

### Configuration

```
grhs init                               Initialize .greenhouse/ in current directory
  --repo <owner/repo>                 Pre-configure a repo

grhs config show                        Print resolved configuration

grhs doctor                             Health checks
                                       Verifies: gh auth, ov installed, sd installed,
                                       git access, config valid, state consistent
```

### Observability

```
grhs logs                               Show daemon logs
  --follow                             Tail mode
  --since <duration>                   Time filter (e.g., "1h", "30m")

grhs budget                             Show daily budget status
  --reset                              Reset daily counter (emergency use)
```

## GitHub Integration

### Issue Polling

```bash
# What greenhouse runs each cycle
gh issue list \
  --repo owner/repo \
  --label "agent-ready" \
  --state open \
  --json number,title,body,labels,assignees \
  --limit 20
```

Issues are filtered client-side against `state.jsonl` to skip already-ingested work.

### Label Mapping

GitHub issue labels map to seeds fields:

| GitHub Label | Seeds Field | Example |
|--------------|-------------|---------|
| `agent-ready` | (trigger) | Required for pickup |
| `area:*` | description prefix | `area:mail` → "[mail] ..." |
| `priority:P0` - `priority:P4` | priority | `priority:P1` → priority 1 |
| `type:bug` / `type:feature` / `type:task` | type | `type:bug` → bug |
| `difficulty:*` | description suffix | `difficulty:hard` → "(hard)" |

Unmapped labels are preserved in the seeds issue description for agent context.

### PR Creation

```bash
# After agents complete and branch is pushed
gh pr create \
  --repo owner/repo \
  --head overstory/lead-42/overstory-a1b2 \
  --base main \
  --title "fix: retry logic in mail client (#42)" \
  --body "$PR_BODY"
```

### Issue Linking

```bash
# Comment on GH issue with PR link
gh issue comment 42 \
  --repo owner/repo \
  --body "Greenhouse opened PR #99 for this issue. Review and merge when ready."
```

Greenhouse does NOT auto-close GitHub issues. The PR description references the issue; GitHub's "closes #N" syntax handles it on merge.

## Integration with Overstory

### Dispatch Flow

```bash
# 1. Change to the target repo
cd /path/to/repo

# 2. Create seeds issue from GH issue data
sd create \
  --title "fix: retry logic in mail client" \
  --type bug \
  --priority 1 \
  --description "From GitHub issue #42\n\n<issue body>" \
  --json

# 3. Dispatch overstory coordinator
ov sling <seeds-task-id> \
  --capability coordinator \
  --json

# 4. Monitor (poll ov status until done)
ov status --json
```

### Completion Detection

Greenhouse polls `ov status --json` on a configurable interval (default: 30s) to detect when agents finish. Agent states reported by overstory are: `"booting" | "working" | "completed" | "stalled" | "zombie"`. A run is "complete" when:

- The agent's `state` field is `"completed"` or `"zombie"`
- As a secondary signal: the seeds task status is `closed`
- OR the agent has been running longer than a timeout (default: 60 minutes) → mark as failed

### Branch Discovery

The branch name is returned directly by `ov sling --json` at dispatch time (see JSON schemas below). Greenhouse stores it in `RunState.branch` and uses it at shipping time. No need to re-discover from `ov status`.

```bash
# Push the branch (stored from ov sling response)
git push origin overstory/lead-42/overstory-a1b2
```

### `ov sling --json` Response Schema

```typescript
{
  success: true;
  command: "sling";
  agentName: string;       // Unique per-session name (e.g., "lead-overstory-a1b2")
  capability: string;      // Agent type (e.g., "lead")
  taskId: string;          // Seeds task ID
  branch: string;          // Git branch: "overstory/{agentName}/{taskId}"
  worktree: string;        // Absolute path to git worktree
  tmuxSession: string;     // Tmux session name (empty string for headless)
  pid: number;             // Process ID of the agent
}
```

### `ov status --json` Response Schema

```typescript
{
  success: true;
  command: "status";
  currentRunId: string | null;
  agents: Array<{
    agentName: string;
    capability: string;
    taskId: string;
    branch: string;
    state: "booting" | "working" | "completed" | "stalled" | "zombie";
    // ... additional fields
  }>;
  worktrees: Array<{ path: string; branch: string; head: string }>;
  tmuxSessions: Array<{ name: string; pid: number }>;
  unreadMailCount: number;
  mergeQueueCount: number;
  recentMetricsCount: number;
}
```

Greenhouse matches agents by `taskId` to correlate `ov sling` responses with `ov status` polling.

## Integration with Seeds

Greenhouse creates seeds issues as the canonical work record. The full lifecycle:

1. **Create**: `sd create --title "..." --type ... --priority ... --description "..." --json`
2. **Claim**: Handled by overstory (agent calls `sd update <id> --status in_progress`)
3. **Close**: Handled by overstory (agent calls `sd close <id> --reason "..."`)
4. **Sync**: `sd sync` after all state changes

### `sd create --json` Response Schema

```typescript
{ success: true; command: "create"; id: string }  // e.g., { id: "overstory-a1b2" }
```

### `sd close --json` Response Schema

```typescript
{ success: true; command: "close"; closed: string[] }  // array of closed IDs
```

### Valid Seeds Enums

- **Types**: `task`, `bug`, `feature`, `epic`
- **Statuses**: `open`, `in_progress`, `closed`
- **Priorities**: `0` (critical) through `4` (low); also accepts `P0`-`P4` notation

Seeds' advisory locking (exclusive file create + stale detection at 30s + atomic temp-file-then-rename) ensures greenhouse and overstory agents don't conflict on concurrent writes.

## Error Handling

### Subprocess Failures

All external CLI calls (`gh`, `ov`, `sd`, `git`) can fail. Greenhouse handles this uniformly:

1. **Capture stderr + exit code** from every subprocess call
2. **Classify** the failure:
   - Exit code non-zero + parseable stderr → structured error
   - Timeout (no output for 30s on short commands) → timeout error
   - Missing binary → fatal, surface in `grhs doctor`
3. **Decide retryability**:
   - Network/transient errors (gh rate limit, git push race) → retryable
   - Logical errors (issue not found, invalid state) → not retryable
   - Unknown errors → not retryable (conservative default)

### Per-Stage Retry Policy

| Stage | Max Retries | Backoff | Notes |
|-------|-------------|---------|-------|
| POLL | 3 | 30s, 60s, 120s | Transient gh failures. Daemon continues on persistent failure (skips cycle). |
| INGEST | 1 | immediate | `sd create` is idempotent (checked against state.jsonl before calling). |
| DISPATCH | 1 | 30s | `ov sling` failure usually means config/resource issue. |
| MONITOR | N/A | N/A | Polling — failures just mean "check again next interval." |
| SHIP | 2 | 30s, 60s | Push races and gh API blips are common. |

After exhausting retries, the run transitions to `FAILED` with the error message and `retryable: false`. Manual `grhs run retry` resets the state to re-attempt.

### Run Timeout

If a run stays in `RUNNING` longer than the configured timeout, greenhouse marks it `FAILED` with `error: "run timeout exceeded"` and `retryable: true`. The agent's tmux session is NOT killed — greenhouse is hands-off on agent lifecycle. The human or overstory watchdog handles cleanup.

## Daemon Process Management

### Foreground Mode (default)

`grhs start` runs the poll loop in the foreground. Ctrl+C sends SIGINT → graceful shutdown (finish current stage, persist state, exit).

### Detached Mode

`grhs start --detach` forks the daemon and writes a PID file:

```
.greenhouse/daemon.pid        # PID of detached process
.greenhouse/daemon.log        # stdout/stderr redirect
```

`grhs stop` reads `.greenhouse/daemon.pid`, sends SIGTERM, waits up to 10s, then SIGKILL if `--force`. Removes PID file on clean exit.

PID file is checked for staleness on startup — if the PID exists but the process is dead, greenhouse removes the stale PID file and starts fresh.

### Signal Handling

| Signal | Behavior |
|--------|----------|
| SIGINT / SIGTERM | Graceful shutdown: finish current stage, persist state, exit 0 |
| SIGHUP | Reload config (re-read config.yaml without restarting) |

## Logging

NDJSON format to match overstory's logging conventions. Each line:

```json
{"ts":"2026-03-05T10:00:00Z","level":"info","msg":"poll cycle complete","repo":"jayminwest/overstory","issues_found":2,"issues_new":1}
```

**Levels:** `debug`, `info`, `warn`, `error`

**Log location:**
- Foreground: stderr (human-formatted with chalk when TTY, NDJSON when piped)
- Detached: `.greenhouse/daemon.log` (always NDJSON)

`grhs logs` reads from `.greenhouse/daemon.log` with `--follow` and `--since` filters.

## What Greenhouse Does NOT Do

Explicitly out of scope:

- **No webhooks.** Polling only. No inbound HTTP, no ngrok, no tunnel.
- **No issue triage.** Issues must be pre-labeled (e.g., `agent-ready`) before greenhouse picks them up. Triage is a human responsibility.
- **No direct main pushes.** Every change goes through a PR. No exceptions.
- **No GitHub issue closing.** PRs reference issues; GitHub closes them on merge.
- **No code review.** Greenhouse ships PRs, it doesn't review them. Human reviews the diff.
- **No retry storms.** Failed runs get one automatic retry (if retryable). After that, manual `grhs run retry` is required.
- **No cross-repo coordination.** Each repo is dispatched independently. No multi-repo atomic changes.
- **No custom GitHub API.** Everything goes through `gh` CLI. If `gh` can't do it, greenhouse doesn't do it.
- **No agent management.** Greenhouse calls `ov sling` and checks `ov status`. It doesn't manage tmux sessions, worktrees, or mail. That's overstory's job.

## Tech Stack

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Runtime | Bun | Matches ecosystem (overstory, seeds, mulch, canopy, sapling) |
| Language | TypeScript (strict) | Matches ecosystem |
| CLI Framework | Commander | Matches ecosystem |
| Output Formatting | chalk | Matches ecosystem |
| Formatting | Biome (tabs, 100 char width) | Matches overstory/seeds/canopy/sapling |
| Storage | JSONL | Git-native, matches seeds pattern |
| Locking | Advisory file locks | Proven pattern from seeds/mulch |
| Config | YAML (minimal built-in parser) | Matches ecosystem convention |
| GitHub | `gh` CLI (subprocess) | No API keys, handles auth/pagination |
| Overstory | `ov` CLI (subprocess) | Decoupled, version-tolerant |
| Seeds | `sd` CLI (subprocess) | Decoupled, version-tolerant |
| Testing | `bun test` (real I/O, no mocks) | Matches ecosystem |
| Distribution | npm (`@os-eco/greenhouse-cli`) | Matches ecosystem |

## Project Infrastructure

### Directory Structure

```
greenhouse/
  package.json
  tsconfig.json
  biome.json
  .gitignore
  SPEC.md
  CLAUDE.md
  CHANGELOG.md
  README.md
  CONTRIBUTING.md
  LICENSE
  CODEOWNERS
  SECURITY.md
  scripts/
    version-bump.ts
  .claude/
    commands/
      release.md
  .github/
    workflows/
      ci.yml
      publish.yml
  src/
    cli.ts               # CLI entry point (Commander setup)
    types.ts             # RunState, DaemonConfig, DailyBudget, etc.
    config.ts            # YAML config loader + validation
    state.ts             # JSONL state persistence (read/write/lock)
    daemon.ts            # Main loop orchestrator
    poller.ts            # GitHub issue fetcher (gh wrapper)
    ingester.ts          # GH issue → seeds issue mapper
    dispatcher.ts        # Overstory sling wrapper
    monitor.ts           # Run completion watcher
    shipper.ts           # git push + gh pr create
    budget.ts            # Daily cap tracker
    output.ts            # JSON + human output helpers
    commands/
      start.ts           # grhs start
      stop.ts            # grhs stop
      status.ts          # grhs status
      runs.ts            # grhs runs / grhs run show|retry|cancel
      poll.ts            # grhs poll (one-shot)
      ingest.ts          # grhs ingest (manual)
      ship.ts            # grhs ship (manual)
      init.ts            # grhs init
      config.ts          # grhs config show
      doctor.ts          # grhs doctor
      logs.ts            # grhs logs
      budget.ts          # grhs budget
    poller.test.ts
    ingester.test.ts
    dispatcher.test.ts
    monitor.test.ts
    shipper.test.ts
    state.test.ts
    budget.test.ts
    config.test.ts
    commands/
      init.test.ts
      doctor.test.ts
```

### Version Management

Version lives in two locations (verified in sync by CI):
- `package.json` — `"version"` field
- `src/cli.ts` — `const VERSION = "X.Y.Z"`

Bump via: `bun run version:bump <major|minor|patch>`

### CHANGELOG.md

[Keep a Changelog](https://keepachangelog.com/) format — same as all ecosystem tools.

### CI Workflow

```yaml
name: CI
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install
      - run: bun run lint
      - run: bun run typecheck
      - run: bun test
```

### Publish Workflow

Auto-tag on version bump + npm publish — same pattern as seeds, canopy, overstory.

## Estimated Size

| Area | Files | LOC |
|------|-------|-----|
| Core (types, config, state, budget, output) | 5 | ~350 |
| Daemon loop (daemon, poller, ingester, dispatcher, monitor, shipper) | 6 | ~600 |
| Commands (12 command files) | 12 | ~500 |
| CLI entry point | 1 | ~80 |
| Tests | 10 | ~600 |
| Scripts | 1 | ~75 |
| Infrastructure (CLAUDE.md, release.md, workflows) | 5 | ~300 |
| **Total** | **40** | **~2,500** |

Small, focused package. Most complexity is sequencing CLI calls and managing state transitions.

## Resolved Design Decisions

1. **`ov sling --json` output shape.** Confirmed — schema pinned in the "Integration with Overstory" section above. Greenhouse extracts `agentName`, `branch`, `taskId`, and `pid` from the response.

2. **`ov status --json` completion signal.** Confirmed — agent `state` field is the primary signal. `"completed"` or `"zombie"` means done. Schema pinned in the "Integration with Overstory" section above.

3. **Branch ownership.** Overstory creates branches at dispatch time in the format `overstory/{agentName}/{taskId}`. Greenhouse receives the branch name from `ov sling --json` and stores it — no branch creation or naming logic in greenhouse.

4. **Concurrency model.** Sequential async/await, no thread parallelism. Monitor-first-then-dispatch per cycle. Documented in the "Concurrency Model" section above.

5. **Config defaults.** Only `repos` is required. All other fields have sensible defaults filled by the config loader. Documented in the `DaemonConfig` type above.
