# Greenhouse Dispatch: greenhouse-3d2b

## Task

- **Seeds ID:** greenhouse-3d2b
- **Title:** Add global CLI options (--quiet, --verbose, --timing)
- **GitHub Issue:** #2 in jayminwest/greenhouse

## Labels

- agent-ready

## Issue Description

Greenhouse CLI is missing common global options that other os-eco tools support:

- `--quiet` — Suppress non-essential output (only errors and JSON)
- `--verbose` — Enable debug-level output for troubleshooting
- `--timing` — Print elapsed time for each command

These should be registered as global options on the root Commander program in `src/cli.ts` and threaded through to the output helpers so all commands respect them.

### Acceptance Criteria
- `grhs --quiet <any-command>` suppresses info/warn output
- `grhs --verbose <any-command>` enables debug-level output
- `grhs --timing <any-command>` prints elapsed time after command completes
- Options work with all existing commands
- Tests cover the new options

## Base Branch

All work must be merged into: `greenhouse/greenhouse-3d2b`

## Instructions

You are a coordinator agent dispatched by Greenhouse to implement a GitHub issue.

1. **Decompose** the task into work streams and spawn lead agents.
2. **Coordinate** lead agents to implement the changes.
3. **Merge** all agent branches into the base branch (`greenhouse/greenhouse-3d2b`) when complete.
4. **Close** the seeds issue when done: `sd close greenhouse-3d2b --reason "..."`
5. **Clean up** all worktrees used by agents when finished.

The base branch `greenhouse/greenhouse-3d2b` is greenhouse's merge target. All work must land here before greenhouse can ship the PR.
