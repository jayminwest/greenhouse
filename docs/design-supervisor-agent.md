# Design: Greenhouse Supervisor Agent

**Status:** Draft
**Date:** 2026-03-06
**Seeds Issue:** TBD

## Problem Statement

Greenhouse's post-dispatch pipeline (monitor → ship → cleanup) is a mechanical state machine that polls for completion signals and reacts to binary outcomes. This approach is fundamentally brittle because it tries to manage an inherently non-deterministic process (LLM agents coordinating code changes) with rigid, code-only heuristics.

### Observed Failure Patterns

From the `greenhouse-26dd` run and historical state analysis:

1. **Race condition in completion detection.** The monitor checks `ov status --json` for task-specific agents. If all agents have exited but the coordinator is still in its cleanup phase (merging branches, about to close the seeds issue), the monitor concludes the run failed. The `greenhouse-26dd` run failed after just 74 seconds with "Agents exited without closing the seeds issue" — likely a false positive.

2. **Empty merge branches.** The coordinator closes the seeds issue without actually merging agent work into `greenhouse/<seedsId>`. The shipper's `recoverAgentBranches()` attempts to salvage by finding `overstory/*/greenhouse-<seedsId>` branches, but this is fragile — branch naming varies, merge conflicts aren't handled, and the recovery has no understanding of what was actually accomplished.

3. **Unintelligent retry.** Failed runs retry the exact same dispatch up to 3 times. There's no analysis of *why* the run failed, no adjustment of strategy, and no ability to pick up partial work. Each retry starts from scratch.

4. **Brittle protocol enforcement.** The dispatch message includes detailed instructions for the coordinator ("close seeds issue LAST", "merge ALL agent work first"), but there's no enforcement. If the coordinator doesn't follow the protocol — which is common since it's an LLM — the entire run fails with no recovery path beyond retry.

5. **Template PR descriptions.** The shipper generates a mechanical PR body (`{seeds_task_id}`, `{agent_summary}` → just the seeds ID). No actual understanding of what changed, why, or what to review.

### Root Cause

The system needs **judgment**, not just polling. A mechanical monitor can detect "agents are gone" but cannot determine why, whether the work is actually complete, or what to do about partial completion.

## Proposed Solution: Per-Run Supervisor Agent

Replace the entire post-dispatch pipeline (monitor, shipper, cleanup, teardown) with a per-run Claude Code instance that runs in a tmux session. After greenhouse dispatches work to the overstory coordinator, it spawns a supervisor that takes ownership of the run through completion.

### Architecture

```
BEFORE (mechanical):
  Greenhouse daemon
    ├── poll → ingest → dispatch (keep)
    ├── monitor (poll sd show + ov status every 30s)  ← REMOVE
    ├── shipper (git push, gh pr create)              ← REMOVE
    ├── cleanup (best-effort branch/worktree cleanup)  ← REMOVE
    └── teardown (ov coordinator stop)                 ← REMOVE

AFTER (intelligent):
  Greenhouse daemon
    ├── poll → ingest → dispatch (keep)
    └── spawn supervisor (one per run, tmux session)
          ├── watch overstory run (with understanding)
          ├── intervene if needed (nudge, fix, recover)
          ├── ship PR (with meaningful description)
          └── cleanup (intelligent state restoration)
```

### Supervisor Lifecycle

```
greenhouse dispatches to coordinator
         │
         ▼
  spawn supervisor CC in tmux
         │
         ▼
  ┌─── WATCH PHASE ──────────────────────────────┐
  │  - Poll sd show / ov status at intervals      │
  │  - Read coordinator mail for progress updates │
  │  - Understand what agents are doing           │
  │  - Detect stalls, errors, hangs               │
  │  - (optional) Intervene: nudge, fix, recover  │
  └──────────────┬────────────────────────────────┘
                 │ seeds issue closed OR all agents terminal
                 ▼
  ┌─── SHIP PHASE ───────────────────────────────┐
  │  - Verify merge branch has agent work         │
  │  - If empty: find & merge agent branches      │
  │  - If conflicts: resolve them                 │
  │  - Run quality gate (test, lint, typecheck)   │
  │  - Write meaningful PR description            │
  │  - git push + gh pr create                    │
  │  - Comment on GitHub issue                    │
  └──────────────┬────────────────────────────────┘
                 │
                 ▼
  ┌─── CLEANUP PHASE ────────────────────────────┐
  │  - Stop coordinator                           │
  │  - Clean overstory worktrees                  │
  │  - Restore repo to main                       │
  │  - Remove spec file                           │
  │  - Update greenhouse state.jsonl              │
  └──────────────┬────────────────────────────────┘
                 │
                 ▼
  supervisor exits, greenhouse detects tmux gone
```

### Supervisor vs Orchestrator

The existing `.overstory/agent-defs/orchestrator.md` is a **multi-repo coordinator of coordinators** — it starts coordinators across sub-repos and coordinates between them. The supervisor is different:

| | Orchestrator | Supervisor |
|---|---|---|
| **Scope** | Multi-repo ecosystem tasks | Single-repo, single-run |
| **Spawned by** | Overstory (as a sling agent) | Greenhouse daemon |
| **Manages** | Per-repo coordinators | One overstory coordination run |
| **Can write code** | No (read-only) | No (but can fix merge conflicts, run git) |
| **Can write files** | No | Yes (PR descriptions, state updates) |
| **Goal** | Distribute work across repos | Get a single run from dispatch to shipped PR |
| **Lifetime** | Duration of multi-repo batch | Duration of one greenhouse run |

### What the Supervisor Can Do (That the Monitor Can't)

1. **Understand partial completion.** Read the actual git diff on the merge branch, check which requirements from the issue are addressed, and make a judgment call about whether to ship partial work or retry.

2. **Resolve merge conflicts.** When agent branches conflict with each other or with main, the supervisor can attempt resolution instead of just failing.

3. **Write real PR descriptions.** Read the diff, understand the changes, write a PR body that explains what was done, why, and what to review.

4. **Handle the race condition.** Instead of "no agents found → failed", the supervisor checks: is the merge branch populated? Is the seeds issue about to be closed? Is the coordinator still running? It uses judgment, not binary checks.

5. **Recover from protocol violations.** If the coordinator closes seeds before merging, the supervisor can still find agent branches, merge them, and ship. If the coordinator never closes seeds but the work is done, the supervisor can close it.

6. **Provide failure diagnostics.** Instead of "Agents exited without closing the seeds issue" (meaningless), the supervisor can analyze what happened and leave a useful GitHub comment.

### Greenhouse Daemon Changes

**What stays the same:**
- Polling GitHub issues (`poller.ts`)
- Ingesting issues to seeds (`ingester.ts`)
- Dispatching to overstory coordinator (`dispatcher.ts`)
- State management (`state.ts`)
- Budget tracking (`budget.ts`)
- PID management (`pid.ts`)

**What changes in the daemon loop:**
- After dispatch, instead of entering the monitor loop, spawn a supervisor tmux session
- The daemon tracks supervisor sessions (tmux pane alive/dead) instead of polling `sd show` + `ov status`
- When a supervisor's tmux session exits, the daemon reads the final state it wrote (to `state.jsonl`) and records the outcome
- No more retry logic in the daemon — the supervisor handles retries intelligently within its session

**New module: `src/supervisor.ts`**
```typescript
interface SupervisorConfig {
  seedsId: string;
  mergeBranch: string;
  repo: RepoConfig;
  config: DaemonConfig;
  specPath?: string;
}

// Spawn a CC instance in a tmux session with a structured prompt
function spawnSupervisor(cfg: SupervisorConfig): Promise<{ sessionName: string; paneId: string }>;

// Check if a supervisor's tmux session is still alive
function isSupervisorAlive(sessionName: string): Promise<boolean>;
```

**Modules to remove/deprecate:**
- `src/monitor.ts` — replaced by supervisor's watch phase
- `src/shipper.ts` — replaced by supervisor's ship phase (though some functions like `recoverAgentBranches` may be useful as reference)
- `src/cleanup.ts` — replaced by supervisor's cleanup phase
- `src/teardown.ts` — replaced by supervisor's cleanup phase

### Supervisor Prompt Design

The supervisor is a Claude Code instance invoked with a structured prompt. Key sections:

1. **Identity & constraints.** You are a greenhouse supervisor for run `<seedsId>`. You do not write application code. You manage git operations, monitor agent progress, and ship PRs.

2. **Run context.** Seeds ID, merge branch, GitHub issue details, dispatch spec, repo config.

3. **Watch protocol.** How to check progress: `sd show`, `ov status`, `ov mail check`. What intervals to use. What constitutes "done" vs "stalled" vs "failed".

4. **Intervention rules.** When to nudge the coordinator. When to send clarification mail. When to give up and fail the run. Budget awareness.

5. **Ship protocol.** How to verify the merge branch. How to handle empty branches (recover agent work). How to write a good PR description. The exact `git push` + `gh pr create` commands.

6. **Cleanup protocol.** What to clean up on success vs failure. How to update `state.jsonl`. How to restore the repo.

7. **State reporting.** The supervisor writes final state to `state.jsonl` via the greenhouse CLI or direct JSONL append, so the daemon knows the outcome.

This prompt should be managed via Canopy (`cn update supervisor`, `cn emit`) so it can evolve independently of the code.

### Invocation

```bash
# Greenhouse spawns this in a tmux session
claude --print \
  --model claude-opus-4-6 \
  --allowedTools "Bash,Read,Write,Edit,Glob,Grep" \
  --systemPrompt "$(cn render supervisor)" \
  "You are supervising greenhouse run ${seedsId}. ..."
```

**Open question:** `--print` mode exits after one response. For a long-running supervisor that needs to watch, intervene, and then ship, we may need:
- A wrapper script that loops: invoke CC, check if it signals "still watching" vs "done", re-invoke if watching
- Or use `claude` in interactive mode via tmux with input piped to it
- Or use the Claude Agent SDK for programmatic control

The tmux approach (like overstory uses for agents) is the most proven path in this ecosystem. The supervisor would run as an interactive `claude` session in a tmux pane, with its initial prompt injected via `tmux send-keys`.

### State Handoff: Supervisor → Daemon

The supervisor communicates its outcome to the daemon by updating `state.jsonl`:

```typescript
// Supervisor writes one of:
// Success: { status: "shipped", prUrl, prNumber, shippedAt }
// Failure: { status: "failed", error: "<diagnostic>", retryable: false }
```

The daemon's simplified monitor loop just checks: is the supervisor tmux session alive? If not, read the latest state for the run — done.

### Migration Path

1. **Phase 1: Build supervisor module + prompt** — `src/supervisor.ts` (spawn/check tmux), Canopy prompt for supervisor behavior
2. **Phase 2: Wire into daemon** — After dispatch, spawn supervisor instead of entering monitor loop. Keep old monitor/shipper as dead code temporarily.
3. **Phase 3: Validate** — Run greenhouse with supervisor on a test issue. Compare behavior to mechanical pipeline.
4. **Phase 4: Remove old pipeline** — Delete `monitor.ts`, `shipper.ts`, `cleanup.ts`, `teardown.ts`. Update tests.

### Open Questions

1. **Model choice.** Should the supervisor use Sonnet (cheaper, faster for routine runs) or Opus (better judgment for edge cases)? Could start with Sonnet and escalate to Opus on failure.

2. **Timeout.** The supervisor itself needs a timeout. If it runs for >90 minutes without shipping, the daemon should kill the tmux session and mark the run as failed.

3. **Cost.** Each supervisor is a full CC session. At ~$0.50-2.00 per run, this is acceptable for the value it provides, but should be tracked.

4. **Concurrent supervisors.** If `max_concurrent: 2`, we have 2 supervisor sessions + 2 coordinator sessions + N agent sessions. Is this too many tmux panes? Probably fine for now.

5. **State.jsonl writes.** The supervisor writes to `state.jsonl` from its tmux session. The daemon also reads `state.jsonl`. Need to ensure no write conflicts (the existing append-only + dedup-on-read pattern should handle this).

6. **Prompt length.** The supervisor prompt needs to include run context, protocols, and tool usage guidance. This could be 2-3K tokens. Canopy composition (base supervisor prompt + per-run context) keeps it manageable.

## Appendix: Current Pipeline Code Being Replaced

| File | Lines | Purpose | Replaced by |
|------|-------|---------|-------------|
| `src/monitor.ts` | 72 | Poll `sd show` + `ov status`, detect completion/failure | Supervisor watch phase |
| `src/shipper.ts` | 250 | Push branch, recover agent branches, create PR | Supervisor ship phase |
| `src/cleanup.ts` | 69 | Post-failure cleanup (checkout main, delete branch, comment) | Supervisor cleanup phase |
| `src/teardown.ts` | 28 | Stop coordinator, remove session-branch.txt | Supervisor cleanup phase |
| `src/daemon.ts:34-171` | 137 | `monitorActiveRuns()` + `advanceShipping()` | Supervisor lifecycle |
| `src/daemon.ts:253-321` | 68 | Retry logic for failed runs | Supervisor internal retry |

Total: ~624 lines of mechanical pipeline replaced by an intelligent agent with a prompt.
