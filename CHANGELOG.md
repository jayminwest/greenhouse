# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-03-05

### Added

- Stop instruction in coordinator dispatch message for graceful task completion

### Fixed

- Add terminal state detection to monitor `checkRunStatus`
- Use `ov status --json` with taskId filtering instead of `coordinator status` for monitoring
- Clean up orphaned overstory tmux sessions on teardown
- `teardownCoordinator` calls `ov coordinator stop` instead of cleanup
- Monitor `sd show` parsing, shipper `gh pr create` flags, and PR auto-close
- Update `teardownCoordinator` test assertions to match `ov coordinator stop`

## [0.1.1] - 2026-03-05

### Added

- Initial project setup

### Fixed

- Fix missing `printError` import in output tests
- Fix `noUncheckedIndexedAccess` violation in shipper PR number extraction

[Unreleased]: https://github.com/jayminwest/greenhouse/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/jayminwest/greenhouse/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/jayminwest/greenhouse/compare/v0.1.0...v0.1.1
