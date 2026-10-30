# Auto Channels (auto-channels)

Bun/TypeScript package that lets Claude Code or pi sessions receive outside events
(webhooks, timers, files, …) through the channels feature. Consumers — usually the
agent itself — add or edit source plugins without restarting their sessions.

## Orientation

- The repo is the package: implementation in `src/`, tests in `test/`.
- One adapter belongs to a session; one shared daemon serves a project.
- Consumer sources and runtime data live in the consumer's `.channels/`, never inside
  the installed package.
- Sources hot-reload. Changing the adapter, the MCP handshake, or the host's set of
  attached servers needs a new session, so the adapter stays thin and rarely changes.

## Rules

[CONTRIBUTING.md](CONTRIBUTING.md) is binding: the gate, the change rules, code style
and test conventions. Additionally, for agents:

- Never modify anything outside this project without explicit manual approval for that
  specific change. Only the scratchpad directory and `/tmp` are exceptions; an approval
  never carries over to another path.
- Only a human bumps a major or minor version. An agent may release a patch
  (`x.y.z` → `x.y.(z+1)`) by following CONTRIBUTING.md's release steps, and nothing larger:
  if a change needs a minor or major release, say so and stop.

## Commands

```bash
bun install
bun run typecheck && bun run lint && bun test     # the gate for every commit
```

## Read for the task

- Consumer setup and examples: `README.md`, then `docs/`
- Architecture, debugging, known limitations: `docs/architecture.md`
- Platform behaviour and the manual live-session check: `docs/claude-code-channels.md`
- API and import boundary: `package.json` and the public declarations it exports
- Configuration: `docs/configuration.md`
- Security model: `SECURITY.md`
- Test harness: `test/e2e/README.md`

## Non-goals

No hosted or multi-tenant service: this runs locally, one user, one machine.
Use official integrations (e.g. `--channels plugin:…@claude-plugins-official`) where
they already solve the consumer's need.
