# Greenhouse Agent Interaction Model

This document describes how greenhouse interacts with overstory agents, seeds tasks, and GitHub issues.

## Overview

Greenhouse is an autonomous development daemon that closes the loop between GitHub issues and pull requests. It polls GitHub for triaged issues, converts them to seeds tasks, dispatches overstory agents to implement them, monitors progress, and opens PRs when work is complete.

## The 6-Stage Pipeline

```
poll → ingest → dispatch → monitor → ship → link
```

### 1. Poll

`pollIssues` fetches open GitHub issues from each configured repo using `gh issue list --json`. Only issues matching **all** configured labels are returned (GitHub's `--label` flag ANDs multiple labels).

```
gh issue list --repo <owner>/<repo> --state open \
  --json number,title,body,labels,assignees \
  --limit 20 \
  --label <label1> --label <label2> ...
```

Issues already in state are skipped (deduplicated by `ghIssueId`).

### 2. Ingest

`ingestIssue` converts a GitHub issue to a seeds task via `sd create --json`. Label mappings:

| GitHub label | Seeds field |
|---|---|
| `type:bug` | `--type bug` |
| `type:feature` | `--type feature` |
| `type:task` | `--type task` (default) |
| `priority:P0`–`priority:P4` | `--priority 0`–`4` (default: 2) |
| `area:<name>` | Prepends `[name] ` to title |
| `difficulty:<level>` | Appends ` (level)` to description |

The description is formatted as:
```
[area] From GitHub issue #<number>

<issue body>(difficulty)
```

### 3. Dispatch

`dispatchRun` spawns an overstory lead agent via `ov sling --json`:

```
ov sling <seedsId> --capability lead --json
```

Run in the `project_root` directory of the repo config. The JSON response populates `agentName`, `branch`, `taskId`, and `pid` in the run state.

### 4. Monitor

`checkRunStatus` polls `ov status --json` on the configured `monitor_interval_seconds` interval:

```
ov status --json
```

The response's `agents` array is scanned for an entry where `taskId` matches. Terminal states:

- `completed` — agent finished successfully
- `zombie` — agent process died (treated as completed; shipper decides outcome)
- agent not found — cleaned up by overstory; treated as completed

Non-terminal states (`booting`, `working`, `stalled`) keep the run in `running` status.

### 5. Ship

`shipRun` pushes the agent branch and opens a GitHub PR:

```bash
git push origin <branch>
gh pr create --repo <owner>/<repo> --head <branch> --base main \
  --title "<ghTitle> (#<ghIssueId>)" --body "<rendered-template>" \
  --json number,url
```

PR title format: `<GitHub issue title> (#<issue number>)`

The PR body is rendered from `config.shipping.pr_template` with these substitutions:

| Placeholder | Value |
|---|---|
| `{github_issue_number}` | GitHub issue number |
| `#{github_issue_number}` | `#<number>` |
| `{seeds_task_id}` | Seeds task ID |
| `{agent_summary}` | `Seeds task: <seedsId>` |

### 6. Link

After the PR is created, greenhouse comments on the original GitHub issue:

```
gh issue comment <issueNumber> --repo <owner>/<repo> \
  --body "Greenhouse opened PR #<number> for this issue. Review and merge when ready."
```

## What Greenhouse Expects from `ov sling --json`

```typescript
interface SlingResult {
  success: boolean;
  command: string;
  agentName: string;   // Unique agent identifier (e.g. "lead-abc123")
  capability: string;  // "lead"
  taskId: string;      // Seeds task ID passed in
  branch: string;      // Git branch the agent will commit to
  worktree: string;    // Absolute path to agent's worktree
  tmuxSession: string; // tmux session name
  pid: number;         // Agent process PID
}
```

Greenhouse stores `agentName`, `branch`, and `taskId` in the run state and uses `branch` for the git push in the ship stage.

## What Greenhouse Expects from `ov status --json`

```typescript
interface StatusResult {
  success: boolean;
  command: string;
  currentRunId: string | null;
  agents: AgentStatus[];
  worktrees: Array<{ path: string; branch: string; head: string }>;
  tmuxSessions: Array<{ name: string; pid: number }>;
  unreadMailCount: number;
  mergeQueueCount: number;
  recentMetricsCount: number;
}

interface AgentStatus {
  agentName: string;
  capability: string;
  taskId: string;    // Matched against run.seedsId to find the right agent
  branch: string;
  state: "booting" | "working" | "completed" | "stalled" | "zombie";
}
```

Greenhouse looks up `agents.find(a => a.taskId === seedsId)`. If no match, the agent is considered completed (already cleaned up).

## What Greenhouse Expects from `sd create --json`

```typescript
interface SdCreateResult {
  success: boolean;
  command: string;
  id: string;  // New seeds task ID (e.g. "repo-a1b2")
}
```

The `id` becomes `run.seedsId` and is passed directly to `ov sling`.

## Branch Names and PR Creation

Branch names come entirely from `ov sling`. Greenhouse does not construct branch names itself — it stores whatever `SlingResult.branch` returns and passes it to `git push origin <branch>` and `gh pr create --head <branch>`.

By overstory convention, agent branches follow the pattern:
```
overstory/<agentName>/<taskId>
```

PRs always target `main` as the base branch (hardcoded).

## State Machine

```
             ┌─────────────────────────────────────┐
             │                                     │
  discovered │        ingestIssue()                │  dispatchRun()
             ▼                                     ▼
         pending ──────────────────────────── ingested ──────────────────────────── running
                                                                                       │
                                                                              monitor loop
                                                                                       │
                                                                           agent terminal?
                                                                          /             \
                                                                        yes              no
                                                                         │               │
                                                                     shipping         (wait)
                                                                         │
                                                                    shipRun()
                                                                   /         \
                                                                 ok           error
                                                                  │               │
                                                              shipped           failed
```

| Status | Description |
|---|---|
| `pending` | Issue discovered by poller; not yet ingested |
| `ingested` | Seeds task created; not yet dispatched to overstory |
| `running` | Agent dispatched and active; monitor polling |
| `shipping` | Agent completed; PR push and creation in progress |
| `shipped` | PR created; GitHub issue commented |
| `failed` | Any stage errored; `run.error` contains the message; `run.retryable` indicates whether retry is safe |

Transitions are written atomically to `.greenhouse/state.jsonl` (append-only, dedup-on-read).

## Budget Enforcement

Before dispatching, greenhouse checks the daily budget:

- `daily_cap` in config sets the maximum dispatches per calendar day
- Budget is computed by counting `RunState` entries with `dispatchedAt` matching today's date (UTC)
- If `dispatched >= cap`, dispatch is skipped for this cycle

## Configuration Reference (relevant fields)

```yaml
dispatch:
  capability: lead              # overstory capability passed to ov sling
  max_concurrent: 3             # max runs in "running" state at once
  monitor_interval_seconds: 30  # how often to poll ov status
  run_timeout_minutes: 120      # max time before a run is marked failed

shipping:
  auto_push: true               # whether to push branch and open PR automatically
  pr_template: ""               # custom PR body template (empty = use default)
```
