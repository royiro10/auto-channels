# Builtin sources

The common shapes ship inside the package as factories — one implementation,
updated with the package, activated per project by one-line files. Create a file in
`.channels/sources/` (any name; it is live the moment you save):

```ts
// .channels/sources/hooks.ts
import { webhook } from 'auto-channels/builtins'
export default webhook({ allowedSenders: ['dev'] })
```

| Builtin | Watches | Options (zero-arg reads the env var) |
|---------|---------|--------------------------------------|
| `webhook()` | inbound HTTP on `127.0.0.1`, gated on the `X-Sender` header | `allowedSenders` (**required** — the gate lives in your activation file), `port` (default 8788 / `WEBHOOK_PORT`), `path`, `name` |
| `cron()` | the passage of time | `intervalMs` (default 60s / `CRON_INTERVAL_MS`), `name` |
| `filedrop()` | files dropped into a directory — waits until a file's size stops changing, never follows symlinks | `dir` (default `.channels/dropbox/` / `FILEDROP_DIR`), `name` |

```ts
import { webhook } from 'auto-channels/builtins'
export default webhook({ allowedSenders: ['dev', 'ci-bot'], port: 9000, path: '/ci' })
```

- Options beat env vars: `WEBHOOK_PORT`, `CRON_INTERVAL_MS` and `FILEDROP_DIR` in the
  adapter registration's env block (`.mcp.json` or `.pi/channels.json`) apply only when
  the matching option is omitted. An invalid value fails only that source's load, logged
  in `daemon.log` ([configuration](configuration.md)).
- Distinct `name`s (and ports/dirs) run two instances of one builtin side by side.
- Verify with the session's `autochannels_list_sources` tool — the description shows the
  instance's actual resolved config.
- Disable by renaming with a leading underscore; delete to remove.

The implementations ([`src/builtins/`](../src/builtins/)) double as reference
code for [writing your own source](sources.md).
