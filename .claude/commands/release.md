## intro

Prepare and ship a release for greenhouse.

## Steps

### 1. Run quality gates

Ensure the codebase is clean before releasing:

```bash
bun run lint
bun run typecheck
bun test
```

All three must pass. Fix any failures before continuing.

### 2. Determine bump type

Ask the user: major, minor, or patch?

- `patch` -- backwards-compatible bug fixes
- `minor` -- new backwards-compatible features
- `major` -- breaking changes

Default to `patch` if not specified.

### 3. Bump the version

```bash
bun run version:bump <major|minor|patch>
```

This updates `package.json` and `src/cli.ts` atomically. Note the old and new version numbers.

### 4. Update CHANGELOG.md

- Move all items from `## [Unreleased]` into a new section: `## [X.Y.Z] - YYYY-MM-DD`
- Leave `## [Unreleased]` empty (with no items listed) at the top
- Update the comparison links at the bottom:
  - `[Unreleased]` should compare the new version against HEAD
  - Add a new link for the new version comparing against the previous version

### 5. Commit the release

```bash
git add package.json src/cli.ts CHANGELOG.md
git commit -m "release: v<new-version>"
```

### 6. Push to main

```bash
git push origin main
```

GitHub Actions will auto-tag `v<version>` and publish to npm.

### 7. Present summary

Show the user:
- Version bump (old -> new)
- Summary of what was released (from CHANGELOG)
- Link to the Actions run (if available)
