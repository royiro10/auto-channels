# Configuration

Everything the tool owns lives under one root, and every location is an env knob set
in your adapter registration's `env` block (relative paths resolve against your
project root):

```json
{
  "mcpServers": {
    "auto-channels": {
      "command": "bun",
      "args": ["./.channels/node_modules/auto-channels/src/adapter/index.ts"],
      "env": { "AUTO_CHANNELS_ROOT": "./.channels" }
    }
  }
}
```

## Environment variables

Framework knobs are resolved by `shared/config.ts`'s `resolveConfig`, once
per process; builtin knobs by the same readers inside the daemon. An invalid value fails loudly, as
`<KNOB> must <constraint>, got "<value>"`. Paths are trimmed, must be non-empty,
and resolve against the project directory (cwd), not the importing module.

| Variable | Default | Configures |
|----------|---------|------------|
| `AUTO_CHANNELS_ROOT` | `<cwd>/.channels` | Where all consumer-owned data lives; the override **replaces** the directory. `"."` = the flat layout. |
| `SOURCES_DIR` | `<root>/sources` | The hot-reloaded sources directory. |
| `CHANNEL_RUN_DIR` | `<root>/run` | The daemon's runtime files. Also the fix when the socket path exceeds the OS's 103-byte Unix-socket limit (a deeply nested project): set it to a short path. |
| `DAEMON_IDLE_SHUTDOWN_MS` | `60000` | How long a daemon with no client waits before stopping itself. |
| `MAX_CLIENT_BUFFER_BYTES` | `4194304` | A client whose write buffer is still above this at a sweep is disconnected. |
| `BACKPRESSURE_CHECK_INTERVAL_MS` | `2000` | How often that sweep runs (a timer, deliberately not inline). |
| `WEBHOOK_PORT` | `8788` | The webhook builtin's port when its `port` option is omitted. |
| `CRON_INTERVAL_MS` | `60000` | The cron builtin's interval when `intervalMs` is omitted. |
| `FILEDROP_DIR` | `<root>/dropbox` | The filedrop builtin's directory when `dir` is omitted. |
| `AGENT_SESSION_ID` | a per-process UUID | The session's name in the daemon's log. Set by the host, not the consumer: pi's channels.tools passes it. |

Builtin factory options beat their env vars ([builtins](builtins.md)).

## When an invalid value surfaces

| Knob | Resolved by | An invalid value surfaces as |
|---|---|---|
| `AUTO_CHANNELS_ROOT`; `CHANNEL_RUN_DIR` and the socket-length check | adapter start, daemon start | the adapter exits before MCP connects: the session fails to start its channel server |
| `SOURCES_DIR`, `DAEMON_IDLE_SHUTDOWN_MS`, `MAX_CLIENT_BUFFER_BYTES`, `BACKPRESSURE_CHECK_INTERVAL_MS` | adapter start and daemon start | the same: the session fails at startup (bug 43) |
| `AGENT_SESSION_ID` | the adapter only | never fails |
| `WEBHOOK_PORT`, `CRON_INTERVAL_MS`, `FILEDROP_DIR`, builtin options, filedrop's default dropbox (via the root) | inside the daemon, at factory or `start()` time | that one source fails to load, logged in `daemon.log`; the rest keep running |

Fix a failing knob in the env block of your adapter registration (`.mcp.json` or
`.pi/channels.json`).

**A running daemon's env is fixed at spawn time.** Sources read the daemon's
`process.env`, inherited from the adapter that spawned it, which carries the
registration's `env` block. Editing that block does not reach a daemon that is
already running: restart the daemon (or let a fresh adapter respawn it).

Sources: [shared/config.ts](../src/shared/config.ts), [daemon/index.ts](../src/daemon/index.ts).
