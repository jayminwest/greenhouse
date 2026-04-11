_Status: research output for v0.2.0 rewrite (greenhouse-4e01). Consumers: dispatcher rewrite (greenhouse-68f2), optional overlay (greenhouse-fadf)._

## TL;DR

- `ov coordinator send --body` delivers the body verbatim as a `dispatch` mail plus a 500-char tmux nudge; the full body is available when the coordinator runs `ov mail check` / `ov mail read`.
- The coordinator prompt has no built-in branch-creation concept and explicitly forbids git-mutating commands (commit, branch switch, merge, remote publish, reset).
- `ov merge` target resolution chain is `--into` flag > `.overstory/session-branch.txt` > `config.project.canonicalBranch`.
- `ov init` derives `canonicalBranch` from `refs/remotes/origin/HEAD`, so pre-checkout of a `greenhouse/<seedsId>` branch does **not** retarget merges — `session-branch.txt` is the only reliable retarget mechanism in a fresh clone.
- The v0.2.0 plan (greenhouse-68f2) as written is **unsafe**: removing `session-branch.txt` writing will cause lead branches to merge into `main` instead of `greenhouse/<seedsId>`.
- Recommended fix: retain ~10 LOC of branch + `session-branch.txt` setup in the rewritten dispatcher; defer the greenhouse-fadf overlay unless dogfood runs show coordinator over-decomposition.

---

## How `ov coordinator send --body` actually works

The `send` subcommand (`coordinator.ts:1406`) calls `sendToPersistentAgent` (`coordinator.ts:888`). That function does two things:

1. Calls `mailClient.send` with `{ from: "operator", to: "coordinator", subject, body, type: "dispatch" }`. The body is stored **verbatim** — no transformation, no truncation in the stored mail.
2. Calls `tmux.sendKeys` with the literal string `[DISPATCH] <subject>: <body[0..500]>`. This is a live nudge to the running coordinator session; it truncates at 500 characters.

```
ov coordinator send --body <text> --subject <text>
  -> sendToPersistentAgent(spec, body, opts)       // coordinator.ts:888
  -> mailClient.send({from: "operator", to: "coordinator",
                      subject, body, type: "dispatch"})
  -> tmux.sendKeys("[DISPATCH] <subject>: <body[0..500]>")
```

**Implication for the 500-char nudge:** The tmux nudge is what wakes the coordinator and gives it a quick preview. If the dispatch body has critical instructions (e.g., branch name, single-issue framing, do-not-expand scope), those instructions must appear in the **opening lines** of the body — not buried after issue description prose.

Sources: `overstory/src/commands/coordinator.ts:1406` (send subcommand), `overstory/src/commands/coordinator.ts:888` (sendToPersistentAgent).

---

## What the coordinator prompt actually says

Source: `overstory/agents/coordinator.md`.

**Workflow (steps 1–9):** receive objective → load expertise → decompose into 2–5 work streams → create seeds issues → `ov sling --capability lead` per stream → monitor mail inbox → `ov merge --branch <lead-branch>` on `merge_ready` signal → `sd close` after merge. There is **no single-issue mode** built in. There is **no built-in concept of "create a named branch and merge into it"**.

**Constraints — forbidden git-mutating commands (verbatim from source):**
- `git commit` — coordinator does not write code
- branch switching commands
- `git merge`
- remote publish commands (push, force-push)
- `git reset`
- Also forbidden: `rm`, `mv`, `cp`, `mkdir` on source directories

The coordinator **cannot** create or switch to a branch on instruction, even if the dispatch body explicitly tells it to. The constraint list is enforced by the prompt, not by tool availability.

**SCOPE_EXPLOSION failure mode:** "Decomposing into too many leads. Target 2–5 leads per batch." The coordinator defaults to multi-lead decomposition. A single-issue dispatch that says nothing explicit about scope will likely spawn 2–3 leads. The dispatch body must include explicit single-issue framing to counteract this default.

**PREMATURE_ISSUE_CLOSE failure mode:** The coordinator is already strict about waiting for a successful merge before closing the seeds issue. The dispatch body does not need to re-emphasize this.

**operator-messages:** The coordinator treats mail from `"operator"` as synchronous requests and always replies. Dispatch mail arrives from `"operator"` (`mailClient.send({ from: "operator", ... })`), so it gets the highest-priority treatment.

---

## Why the v0.2.0 plan as written is unsafe

The greenhouse-68f2 plan removes two infrastructure steps from the dispatcher:
1. Pre-creation of the `greenhouse/<seedsId>` merge branch.
2. Writing `.overstory/session-branch.txt`.

The plan then relies on the dispatch body telling the coordinator "merge all work into branch `greenhouse/<seedsId>`" — expecting the coordinator to create the branch and target `ov merge` at it via prompt-following.

**Concrete failure scenario:**

1. Fresh clone: `origin/HEAD` → `main`. `ov init` reads `refs/remotes/origin/HEAD`, sets `canonicalBranch = "main"`. No `session-branch.txt` exists.
2. Coordinator receives dispatch, decomposes, spawns a lead, lead finishes, sends `merge_ready`.
3. Coordinator runs `ov merge --branch <lead-branch>`. Target resolution: no `--into` flag → no `session-branch.txt` → falls back to `config.project.canonicalBranch` = `"main"`. Lead work **merges into `main`**.
4. Shipper (greenhouse-d5f1) runs `git branch --list greenhouse/*` in the fresh clone. Finds **nothing** — no `greenhouse/<seedsId>` branch was ever created.
5. Shipper fails or opens an empty PR. The run is broken.

**Why the coordinator prompt overlay (greenhouse-fadf) cannot fix this:**

The overlay can add framing and decomposition caps to the coordinator prompt. It cannot fix the merge target problem because:
- The coordinator's constraint list forbids git-mutating commands. Even if the dispatch body or overlay says "run `git checkout -b greenhouse/<seedsId>`", the coordinator will not execute it.
- `ov merge` resolves its target from `config.project.canonicalBranch` (derived from `origin/HEAD`) or `session-branch.txt`. Neither of these is controlled by the coordinator's mail-reading behavior. Free-form instructions in the dispatch body or overlay cannot redirect `ov merge` without also modifying the dispatcher infrastructure or `ov merge` itself.

The overlay is useful for controlling decomposition depth. It is **not** a substitute for dispatcher-side branch setup.

---

## Recommended dispatcher sequence (for greenhouse-68f2)

The fix is small: retain two setup steps in the rewritten dispatcher before calling `ov init`. This is ~10 LOC and is deterministic — no coordinator prompt-following required.

```typescript
async function dispatchToClone(
  seedsId: string,
  issue: GitHubIssue,
  cloneDir: string,
  exec: ExecFn,
): Promise<DispatchResult> {
  // 1. Clone already done upstream in daemon — cloneDir is ready.

  // 2. *** RETENTION *** Create and switch to the greenhouse branch.
  //    This is the work branch; all agent merges target it.
  await exec(["git", "checkout", "-b", `greenhouse/${seedsId}`], { cwd: cloneDir });

  // 3. *** RETENTION *** Pin ov merge target via session-branch.txt.
  //    Without this, ov merge falls back to canonicalBranch (main).
  const sessionBranchPath = join(cloneDir, ".overstory", "session-branch.txt");
  await mkdir(dirname(sessionBranchPath), { recursive: true });
  await Bun.write(sessionBranchPath, `greenhouse/${seedsId}\n`);

  // 4. Initialize overstory in the fresh clone.
  await exec(["ov", "init", "--yes", "--skip-onboard", "--json"], { cwd: cloneDir });

  // 5. Ensure coordinator is running (idempotent).
  await exec(["ov", "coordinator", "start", "--watchdog", "--json"], { cwd: cloneDir });

  // 6. Send the dispatch mail. Body is rendered from the template below.
  const body = renderDispatchBody(seedsId, issue);
  const result = await exec(
    ["ov", "coordinator", "send",
     "--subject", `Objective: ${issue.title}`,
     "--body", body,
     "--json"],
    { cwd: cloneDir },
  );

  return parseDispatchResult(result.stdout);
}
```

With steps 2 and 3 in place:
- `ov merge --branch <lead-branch>` inside the coordinator session resolves to `greenhouse/${seedsId}` via `session-branch.txt`.
- The shipper's `git branch --list greenhouse/*` probe finds exactly one match in the fresh clone.
- The dispatch body does not need to rely on coordinator prompt interpretation for branch correctness.

The shipper (greenhouse-d5f1) can still use `git branch --list greenhouse/*` to detect the work branch after the run — in a fresh clone there will be exactly one `greenhouse/` branch.

---

## The dispatch body template

The following template is the `--body` value passed to `ov coordinator send`. Render it with `renderDispatchBody(seedsId, issue)` before the send call (see Substitution pattern below).

````markdown
# Greenhouse Dispatch: {{seedsId}}

You were dispatched by greenhouse to work on exactly ONE GitHub issue. This is a
single-issue run, not a batch. Do not create additional seeds issues, do not explore
adjacent work, do not decompose beyond what this issue requires.

## The Issue

- **Seeds ID:** {{seedsId}}
- **Title:** {{ghIssueTitle}}
- **GitHub Issue:** {{ghRepo}}#{{ghIssueNumber}}

## Issue Description

{{ghIssueBody}}

## Your Job

Implement this one issue. Merge all resulting work into branch `greenhouse/{{seedsId}}`
(already checked out as the current branch and pinned as `ov merge` target via
`.overstory/session-branch.txt`). When the work lands on that branch, close the seeds
issue — and only then.

## Sizing Guidance

This is almost certainly ONE lead with ONE builder. Do not decompose into 3–5 parallel
leads unless the issue genuinely spans multiple independent subsystems. Prefer direct
builder fallback (`ov sling --capability builder`) when the work is a single localized
change. Every extra agent costs a full Claude session; greenhouse runs one issue per
clone and is cost-sensitive. If you spawn a lead, give it a single clear objective —
do not expand the scope.

## Branch and Merge Rules

- Work branch is `greenhouse/{{seedsId}}`, already current in this clone.
- `ov merge --branch <lead-branch>` will merge into `greenhouse/{{seedsId}}`
  automatically via the `session-branch.txt` pointer — do not pass `--into main`.
- Do NOT publish the branch to the remote — greenhouse handles branch publication.
- Do NOT open a PR — greenhouse opens the PR after detecting the closed seeds issue.

## Completion Signal

Verify the merge branch contains feature commits:

```bash
git log greenhouse/{{seedsId}}
```

Then close the seeds issue with a summary reason:

```bash
sd close {{seedsId}} --reason "<one-sentence summary of what was implemented>"
```

Closing early ships an empty PR. Closing after a failed merge ships broken code.
Neither is recoverable without human intervention. Close only after a successful merge.

## Escalation

If the issue is underspecified, ambiguous, or blocked by missing infrastructure, send
an error-type mail to `operator` with the specifics and **do NOT close the seeds
issue**. Greenhouse surfaces failures by commenting on {{ghRepo}}#{{ghIssueNumber}}
and flipping its label to `greenhouse:failed`.
````

---

## Placeholder reference

| Placeholder | Source | Example |
|---|---|---|
| `{{seedsId}}` | return value of `createSeedsTask(issue, cloneDir, exec)` | `greenhouse-4e01` |
| `{{ghIssueTitle}}` | `gh issue view --json title` | `v0.2.0: Rewrite src/dispatcher.ts` |
| `{{ghIssueBody}}` | `gh issue view --json body` | (multi-line markdown) |
| `{{ghIssueNumber}}` | `gh issue view --json number` | `20` |
| `{{ghRepo}}` | `owner/repo` from repo config | `jayminwest/greenhouse` |

---

## Substitution pattern

Reuse the same regex-replace pattern the current shipper uses for PR template variables
(see mulch record mx-f51f37: `.replace` with a per-placeholder regex and the global flag).
Keep all substitutions in a single `renderDispatchBody` helper in `src/dispatcher.ts`
so tests can unit-test it without invoking `ov coordinator send`:

```typescript
export function renderDispatchBody(
  seedsId: string,
  issue: { title: string; body: string; number: number; repo: string },
): string {
  return DISPATCH_BODY_TEMPLATE
    .replace(/\{\{seedsId\}\}/g, seedsId)
    .replace(/\{\{ghIssueTitle\}\}/g, issue.title)
    .replace(/\{\{ghIssueBody\}\}/g, issue.body)
    .replace(/\{\{ghIssueNumber\}\}/g, String(issue.number))
    .replace(/\{\{ghRepo\}\}/g, issue.repo);
}
```

The template string `DISPATCH_BODY_TEMPLATE` can live as a module-level `const` in
`src/dispatcher.ts` or in a dedicated `src/dispatch-template.ts` — the key constraint
is that it must be testable without a live `ov coordinator send` invocation.

---

## Relationship to the optional overlay (greenhouse-fadf)

With the dispatcher sequence above (branch checkout + `session-branch.txt` write before
`ov init`), the greenhouse-fadf coordinator prompt overlay is **optional**. The merge
target is fixed at the infrastructure level regardless of what the coordinator does.

The overlay becomes valuable in one specific scenario: **if dogfood runs show that the
coordinator over-decomposes a single-issue dispatch into 3+ leads when 1 would suffice.**
In that case, the overlay can bake the single-issue framing and decomposition cap into
the coordinator prompt itself — making it a hard constraint rather than a soft nudge in
the dispatch body.

Recommendation: ship greenhouse-68f2 with the two-line branch-setup retention and the
dispatch body template above. Defer greenhouse-fadf until dogfood runs provide evidence
of over-decomposition. If dogfood runs do show consistent over-decomposition, promote
the overlay from optional to required.

---

## Evidence and references

- `overstory/src/commands/coordinator.ts:888` — `sendToPersistentAgent` implementation (mail send + tmux nudge)
- `overstory/src/commands/coordinator.ts:1406` — `send` subcommand wiring
- `overstory/agents/coordinator.md` — sections: workflow, constraints, failure-modes (SCOPE_EXPLOSION, PREMATURE_ISSUE_CLOSE), communication-protocol, operator-messages
- `overstory/src/commands/merge.ts:149` — `ov merge` target resolution chain (`--into` > `session-branch.txt` > `canonicalBranch`)
- `overstory/src/commands/init.ts:240` — `detectCanonicalBranch` (reads `refs/remotes/origin/HEAD` first)
- `greenhouse/src/dispatcher.ts` — `createMergeBranch` (~line 86), `setupSessionBranch` (~line 104), `buildDispatchMessage` (~line 27)
- Mulch records: mx-32267e (session-branch.txt is the current mechanism), mx-741449 (session-branch.txt lifecycle), mx-a7b644 (buildDispatchMessage structured spec), mx-748979 (e2e pipeline worked end-to-end with session-branch.txt in place)
