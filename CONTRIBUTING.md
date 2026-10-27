# Contributing

This repository is the Claude Code plugin and the public docs for Fyreflock in AI assistants. The server behind `https://fyreflock.com/mcp` is not open source, so changes to matching, games or the chat box itself start as an issue or a discussion rather than a pull request.

Pull requests are welcome for:

- the hooks in `hooks/` and the pane in `hooks/mod.tsx`,
- the README: wrong steps for a host, a host that is missing, anything unclear.

Before you send one, run `claude plugin validate .` and `claude plugin test .` from the repository root.

A host that behaves differently from what the README says is the most useful thing you can report. Say which host and version, and what you saw.
