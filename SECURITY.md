# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

Only the latest release on the current major version line receives security updates.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Please report vulnerabilities privately by emailing jayminwest@gmail.com with the subject line `[greenhouse] Security Vulnerability`.

Include:
- A description of the vulnerability
- Steps to reproduce
- Potential impact

### Response Timeline

- **Acknowledgment**: Within 48 hours of your report
- **Initial assessment**: Within 7 days
- **Fix or mitigation**: Within 30 days for confirmed vulnerabilities

We will keep you informed of progress throughout the process.

## Scope

Greenhouse is a CLI daemon that polls GitHub and dispatches overstory runs on the local filesystem. The following are considered security issues:

- **Command injection** -- Unsanitized GitHub issue content passed to `Bun.spawn` or shell execution
- **Path traversal** -- Accessing files outside the intended project or `.greenhouse/` directory
- **State corruption** -- Crafted input that corrupts `state.jsonl` and causes unintended dispatches
- **Daily cap bypass** -- Input that circumvents the configured `daily_cap` limit

The following are generally **not** in scope:

- Denial of service via large input (Greenhouse is a local tool, not a service)
- Issues that require the attacker to already have local shell access with the same privileges as the user
- Costs incurred from dispatching many agents (operational concern, not a security vulnerability)

## Security Notes

Greenhouse is designed with a minimal attack surface:

- **No token management.** All GitHub auth is delegated to `gh` CLI. Greenhouse never reads or stores OAuth tokens.
- **No inbound connections.** Polling only. No HTTP server, no webhooks, no exposed ports.
- **No canonical branch pushes.** All changes go through PRs. Greenhouse never merges.
- **No code evaluation from issues.** Issue bodies are treated as data, not executed.
