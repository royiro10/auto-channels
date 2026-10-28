# Auto Channels

**Let an agent session (Claude Code or pi) react to the outside world — without a human re-prompting it.**

![license: MIT](https://img.shields.io/badge/license-MIT-blue)
![status: pre-1.0](https://img.shields.io/badge/status-pre--1.0-orange)
![bun: ≥1.2](https://img.shields.io/badge/bun-%E2%89%A51.2-black)

```
you:     curl -X POST -H "X-Sender: dev" localhost:8788 -d "build failed on main"
claude:  <channel origin="webhook">build failed on main</channel>
         → reads it, reruns the failing test, starts fixing — mid-session, unprompted
```

A *source* — an event-source plugin — is a small script that watches for
something happening outside the session (a webhook, a timer, a file landing in a
directory) and pushes it straight into the transcript as it happens, via Claude Code's
[channels](https://code.claude.com/docs/en/channels) feature. Add, edit, or delete a
source by saving a file in your own project; it's live immediately — no restarts,
no registration, no redeploy.

## Requirements

[Bun](https://bun.sh) ≥ 1.2, plus either Claude Code v2.1.80+ with channels enabled
(research preview) or [pi](https://pi.dev) with the channels.tools extension
([using it from pi](https://github.com/royiro10/auto-channels/blob/HEAD/docs/pi.md)).

## Quickstart

```bash
bunx auto-channels init      # once published; from this checkout, see below
claude --dangerously-load-development-channels server:auto-channels
```

`init` creates one adapter registration per host you select — `.mcp.json` at your
project root for Claude Code (the default), `.pi/channels.json` for pi — and one
self-contained `.channels/` directory owning everything else, its own `node_modules`
included, so a non-JS repo gains no root-level JS toolchain files. It's also safe in a project that's already set up: existing JSON
configs gain only the missing entries (your other MCP servers survive untouched), and
nothing is ever overwritten.

From this unpublished checkout, replace the first line with:

```bash
cd <checkout> && bun link                # once: puts `auto-channels` on your PATH
cd <your-project> && auto-channels init
```

Nothing runs until you opt in. Enable your first source with a one-line file:

```ts
// .channels/sources/hooks.ts — live the moment you save it
import { webhook } from 'auto-channels/builtins'
export default webhook({ allowedSenders: ['dev'] })
```

Then, from another terminal:

```bash
curl -X POST -H "X-Sender: dev" localhost:8788 -d "build failed on main"
```

## Example: the webhook builtin

```ts
import { webhook } from 'auto-channels/builtins'
export default webhook({ allowedSenders: ['dev', 'ci-bot'], port: 9000, path: '/ci' })
```

`allowedSenders` is **required**: the gate on the `X-Sender` header lives in your activation
file. Every option, plus `cron()` and `filedrop()`: [builtin sources](https://github.com/royiro10/auto-channels/blob/HEAD/docs/builtins.md).

## The one hard rule

Channels only reach a real *interactive* `claude` session.
`-p`/print mode structurally never receives channel events — confirmed empirically,
not a timing fluke (see [how Claude Code channels behave](https://github.com/royiro10/auto-channels/blob/HEAD/docs/claude-code-channels.md)).
`--dangerously-load-development-channels` is required for any custom channel during
the research preview.

## Documentation

- [Writing your own source](https://github.com/royiro10/auto-channels/blob/HEAD/docs/sources.md) — the contract, gating, testing, opt-in
  delivery, multiple sessions.
- [Builtin sources](https://github.com/royiro10/auto-channels/blob/HEAD/docs/builtins.md) — `webhook`, `cron`, `filedrop` and their options.
- [Configuration](https://github.com/royiro10/auto-channels/blob/HEAD/docs/configuration.md) — env vars and when an invalid one fails.
- [Using it from pi](https://github.com/royiro10/auto-channels/blob/HEAD/docs/pi.md).
- [Architecture and debugging](https://github.com/royiro10/auto-channels/blob/HEAD/docs/architecture.md) — the daemon, `daemon.log`, the
  status file, restarts, known limitations.
- [How Claude Code channels behave](https://github.com/royiro10/auto-channels/blob/HEAD/docs/claude-code-channels.md) — the platform facts this
  design rests on.

## Contributing

Issues and pull requests welcome; the dev setup, the gate and the rules for changing
the code are in [CONTRIBUTING.md](https://github.com/royiro10/auto-channels/blob/HEAD/CONTRIBUTING.md).

## Security

Report vulnerabilities privately, not in public issues: see [SECURITY.md](https://github.com/royiro10/auto-channels/blob/HEAD/SECURITY.md).

## License

[MIT](https://github.com/royiro10/auto-channels/blob/HEAD/LICENSE)
