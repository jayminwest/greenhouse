# Contributing to Greenhouse

Thanks for your interest in contributing to Greenhouse!

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/greenhouse.git
   cd greenhouse
   ```
3. **Install** dependencies:
   ```bash
   bun install
   ```
4. **Link** the CLI for local development:
   ```bash
   bun link
   ```
5. **Create a branch** for your work:
   ```bash
   git checkout -b fix/description-of-change
   ```

## Branch Naming

Use descriptive branch names with a category prefix:

- `fix/` -- Bug fixes
- `feat/` -- New features
- `docs/` -- Documentation changes
- `refactor/` -- Code refactoring
- `test/` -- Test additions or fixes

## Quality Gates

Always run all three gates before submitting a PR:

```bash
bun run lint          # Biome lint + format check
bun run typecheck     # tsc --noEmit
bun test              # All tests must pass
```

Auto-fix lint and format issues:

```bash
biome check --write .
```

## Code Style

Greenhouse follows the os-eco TypeScript conventions:

- **TypeScript strict mode** -- `noUncheckedIndexedAccess`, no `any`, no `!` assertions
- **Tab indentation** (enforced by Biome)
- **100 character line width** (enforced by Biome)
- **Zero runtime dependencies** -- use only Bun built-in APIs (`bun:sqlite`, `Bun.spawn`, `Bun.file`, `Bun.write`)
- External tools (`gh`, `ov`, `sd`, `git`) are invoked as subprocesses via `Bun.spawn`, never imported

See SPEC.md for architecture details and module descriptions.

## Testing

- **No mocks** unless absolutely necessary. Tests use real filesystems and real subprocesses.
- Create temp directories with `mkdtemp` for file I/O tests
- Clean up in `afterEach`
- Tests are colocated with source files: `src/config.test.ts` alongside `src/config.ts`

Only mock when the real thing has unacceptable side effects (live GitHub API calls, live overstory runs). When mocking is necessary, document WHY in a comment at the top of the test file.

Example test structure:

```typescript
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it, expect } from "bun:test";

describe("my-feature", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "greenhouse-test-"));
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true });
	});

	it("does the thing", async () => {
		// Write real files, run real code, assert real results
	});
});
```

## Versioning

Version lives in two locations (verified in sync by CI):

- `package.json` -- `"version"` field
- `src/cli.ts` -- `const VERSION = "X.Y.Z"`

Bump via:

```bash
bun run version:bump <major|minor|patch>
```

This updates both files atomically. Do not edit them by hand.

## Commit Message Style

Use imperative, concise commit messages:

```
fix: retry logic for transient gh CLI failures
feat: add grhs budget --reset flag
docs: update CLI reference for grhs run cancel
```

Prefix with `fix:`, `feat:`, or `docs:` when the category is clear.

## Pull Request Expectations

- **One concern per PR.** Bug fix, feature, or refactor -- not all three.
- **Tests required.** New features and bug fixes must include tests.
- **Passing CI.** All PRs must pass lint + typecheck + test before merge.
- **Description.** Briefly explain what the PR does and why.

## Reporting Issues

Use [GitHub Issues](https://github.com/jayminwest/greenhouse/issues) for bug reports and feature requests. For security vulnerabilities, see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
