# Greenhouse

Autonomous development daemon for AI agent workflows.

[![npm](https://img.shields.io/npm/v/@os-eco/greenhouse-cli)](https://www.npmjs.com/package/@os-eco/greenhouse-cli)
[![CI](https://github.com/jayminwest/greenhouse/actions/workflows/ci.yml/badge.svg)](https://github.com/jayminwest/greenhouse/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Greenhouse closes the last manual loop in the os-eco toolchain. It polls GitHub for pre-triaged issues, creates seeds tasks, dispatches overstory runs, and opens PRs when agents finish. The only human touchpoint is merging the PR.

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- [GitHub CLI](https://cli.github.com) (`gh`) — authenticated
- [Overstory](https://github.com/jayminwest/overstory) (`ov`) — installed and initialized
- [Seeds](https://github.com/jayminwest/seeds) (`sd`) — initialized in your project

Run `grhs doctor` to verify all prerequisites and configuration.

## Install

```bash
bun add -g @os-eco/greenhouse-cli
```

Or try without installing:

```bash
bunx @os-eco/greenhouse-cli --help
```

### Development

```bash
git clone https://github.com/jayminwest/greenhouse.git
cd greenhouse
bun install
bun link              # Makes 'greenhouse' and 'grhs' available globally

bun test              # Run all tests
bun run lint          # Biome check
bun run typecheck     # tsc --noEmit
```

## Quick Start

```bash
# 1. Initialize .greenhouse/ in your project
cd your-project
grhs init --repo owner/repo

# 2. Edit .greenhouse/config.yaml to configure your repos and labels
#    (see Configuration below)

# 3. Verify your setup
grhs doctor

# 4. Run one poll cycle to test
grhs poll

# 5. Start the daemon
grhs start
```

## How It Works

Each daemon cycle runs these stages:

1. **Monitor** — checks active supervisor sessions for timeout or unexpected exit
2. **Poll** — `gh issue list` fetches open issues with the configured labels
3. **Ingest** — `sd create` converts each new issue to a seeds task
4. **Dispatch** — `ov coordinator send` sends the task to the overstory coordinator, then `spawnSupervisor()` launches a dedicated supervisor tmux session to own the run through completion

The **supervisor** handles the rest: it monitors the coordinator, detects completion (seeds issue closure), pushes the merge branch, creates a PR via `gh pr create`, and cleans up.

Greenhouse never pushes to the canonical branch. Every run produces a PR for human review.

## Configuration

Initialize with `grhs init`, then edit `.greenhouse/config.yaml`:

```yaml
version: "1"

repos:
  - owner: jayminwest
    repo: overstory
    labels:
      - agent-ready
    project_root: /path/to/local/clone

poll_interval_minutes: 10
daily_cap: 5

dispatch:
  capability: coordinator
  max_concurrent: 2
  monitor_interval_seconds: 30
  run_timeout_minutes: 90
  supervisor_model: claude-sonnet-4-6  # optional

shipping:
  auto_push: true
  auto_merge: false  # optional: auto-merge PR after creation
```

Only `repos` is required. All other fields have sensible defaults. See SPEC.md for the full configuration reference.

## CLI Reference

Binary: `greenhouse` / `grhs`

Every command supports `--json` for structured output.

### Daemon Commands

| Command | Description |
|---------|-------------|
| `grhs start` | Start the daemon (foreground) |
| `grhs start --detach` | Run in background (writes PID file) |
| `grhs stop` | Stop a detached daemon |
| `grhs status` | Show daemon state, active runs, budget, next poll |

### Run Management

| Command | Description |
|---------|-------------|
| `grhs runs list` | List all tracked runs |
| `grhs runs list --status <status>` | Filter by status (pending/running/shipped/failed) |
| `grhs runs show <gh-issue-id>` | Show detailed run state |
| `grhs runs retry <gh-issue-id>` | Retry a failed run |
| `grhs runs cancel <gh-issue-id>` | Cancel a pending or running run |
| `grhs runs clean` | Remove completed/failed runs from state |

### Manual Operations

| Command | Description |
|---------|-------------|
| `grhs poll` | Run one poll cycle (without starting daemon) |
| `grhs ingest <gh-issue-url>` | Manually ingest a single issue (bypasses label filter and daily cap) |

### Utilities

| Command | Description |
|---------|-------------|
| `grhs init` | Initialize `.greenhouse/` in current directory |
| `grhs config show` | Print resolved configuration |
| `grhs doctor` | Health checks (gh auth, ov, sd, git, config, state) |
| `grhs logs` | Show daemon logs |
| `grhs logs --follow` | Tail mode — stream new entries as they appear |
| `grhs logs --since <duration>` | Filter by time (e.g. `1h`, `30m`, `90s`) |
| `grhs budget` | Show daily budget status |

## Design Principles

- **Shell out, don't import.** Greenhouse calls `ov`, `sd`, and `gh` via CLI. No internal coupling to ecosystem tool internals.
- **Cron over webhooks.** Poll on a configurable interval. No inbound networking, no tunnels, works on home servers.
- **Idempotent everything.** Every poll cycle is safe to re-run. Already-ingested issues are skipped.
- **Daily cap as cost control.** Configurable limit on issues dispatched per day. Simple, predictable.
- **PR as the human gate.** Greenhouse never merges. Every run produces a PR. Full audit trail.

## Part of os-eco

Greenhouse is part of the [os-eco](https://github.com/jayminwest/os-eco) AI agent tooling ecosystem.

| Tool | Purpose |
|------|---------|
| [Overstory](https://github.com/jayminwest/overstory) | Multi-agent orchestration |
| [Seeds](https://github.com/jayminwest/seeds) | Git-native issue tracking |
| [Mulch](https://github.com/jayminwest/mulch) | Structured expertise management |
| [Canopy](https://github.com/jayminwest/canopy) | Prompt management |

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT
