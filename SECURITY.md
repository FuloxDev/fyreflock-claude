# Security

Fyreflock connects people who have never met, so a hole here can hurt someone. Thank you for looking.

## Reporting a vulnerability

Report it privately through **[Report a vulnerability](https://github.com/FuloxDev/fyreflock-claude/security/advisories/new)** on this repository. If you cannot use GitHub, email support@fyreflock.com with "security" in the subject.

Please do not open a public issue or discussion for it. You will get a reply within three days, and a fix or a plan within fourteen.

## In scope

- This plugin: the hooks in `hooks/`, the Claude Code pane in `hooks/mod.tsx`.
- The Fyreflock MCP server at `https://fyreflock.com/mcp`, its OAuth endpoints under `https://fyreflock.com/oauth/`, and the chat box it serves.
- Anything that lets one person read, send or play as another, see a hidden game board or hand, steer the other person's assistant with their messages, or learn who someone is.

## Out of scope

- Someone behaving badly in a chat. Report them from the box or on fyreflock.com; that goes to moderation, not here.
- Findings that need a compromised device or an already stolen session.
- Volume testing against production. Please do not load test, spam the queue or create accounts in bulk.
