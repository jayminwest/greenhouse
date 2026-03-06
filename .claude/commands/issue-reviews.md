---
name: issue-reviews
---

## intro

Review open GitHub issues for priority, feasibility, project alignment, and risks.

**Argument:** `$ARGUMENTS` — optional issue number(s) to review (e.g., `5` or `5 8 12`). If empty, review all open issues.

## Steps

### 1. Discover issues to review

- If `$ARGUMENTS` contains issue number(s), use those
- Otherwise, run `gh issue list --state open --json number,title,author,labels,createdAt,updatedAt,comments` to get all open issues
- If there are no open issues, say so and stop

### 2. Spawn a review team

Use the Task tool to spawn parallel agents (one per issue, or batch small sets if there are many). Each agent should:

#### a. Gather context
- `gh issue view <number> --json title,body,author,labels,comments,createdAt,updatedAt`
- Read any files referenced in the issue body or comments
- Search the codebase for related code (`Grep`/`Glob` for keywords, function names, file paths mentioned)
- Check if there are related open PRs: `gh pr list --state open --search "<issue-title-keywords>"`

#### b. Feasibility assessment
- Is the issue well-defined enough to act on?
- What files/subsystems would need to change?
- Estimate scope: small (1-2 files), medium (3-5 files), large (6+ files / architectural)
- Are there prerequisite changes or dependencies on other issues?
- Are there technical blockers or unknowns?

#### c. Project alignment review
- Does this issue align with greenhouse's goals (autonomous development daemon, GitHub polling, overstory dispatch)?
- Does it conflict with existing architecture decisions?
- Is it a feature request, bug fix, improvement, or maintenance task?
- Would addressing it create technical debt or reduce it?

#### d. Risk assessment
- What could go wrong if this is implemented naively?
- Are there breaking changes or migration concerns?
- Does it touch critical infrastructure (daemon, poller, dispatcher, ingester)?
- Could it introduce performance regressions?
- Are there security implications?

#### e. Priority recommendation
- **Critical** — Blocks users or breaks core functionality
- **High** — Significant improvement, clear path to implement
- **Medium** — Useful but not urgent, well-scoped
- **Low** — Nice-to-have, unclear scope, or minimal impact
- **Wontfix** — Doesn't align with project direction, or cost outweighs benefit

#### f. Produce a review summary
Each agent should return a structured review:
- **Issue:** `#<number> — <title>` by `<author>`
- **Type:** Bug / Feature / Improvement / Maintenance
- **Recommended priority:** Critical / High / Medium / Low / Wontfix
- **Scope:** Small / Medium / Large
- **Summary:** 2-3 sentence assessment
- **Alignment:** How well it fits greenhouse's direction
- **Risks:** Potential pitfalls or concerns
- **Suggestions:** Refinements to the issue, alternative approaches, or related work
- **Related code:** Key files/subsystems that would be affected

### 3. Present consolidated report

After all agents complete, present a single consolidated report with:
- A priority-sorted summary table of all reviewed issues
- The detailed review for each issue
- Cross-cutting themes (are multiple issues pointing to the same underlying problem?)
- Recommended action plan: which issues to tackle first, which to defer, which to close
- Any issues that should be split, merged, or rewritten for clarity
