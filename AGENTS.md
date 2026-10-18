# AGENTS.md

This repository uses [`CLAUDE.md`](./CLAUDE.md) as the single agent-orientation document. It covers what polyman is, the repo layout, build/lint/run commands, conventions enforced by tooling, the action → step → helper → executor mental model, the solution-tag verdict system, Polygon integration notes, and common pitfalls.

**All AI agents — Claude Code, Cursor, Aider, Codex, Continue, etc. — should read [`CLAUDE.md`](./CLAUDE.md) before making changes.**

Agents that only review or propose (they change no file) don't need to read it: read the parts of `CLAUDE.md` that cover the files you're looking at, when a finding depends on a convention.

The content is agent-agnostic; the filename is historical. If your tool prefers `AGENTS.md`, this file points you to the same content.
