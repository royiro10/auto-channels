# e2e tests

Each file drives real adapter processes (the MCP SDK's `StdioClientTransport`
spawning `src/adapter/index.ts`, exactly the way a host does) against a real
daemon, through one isolated project fixture from `helpers.ts`:

```ts
const project = projectFixture({ sources: { 'webhook.ts': seed('webhook') }, env: {}, mode: 'repo' })
```

The rules — isolation, the scrubbed env, owned cleanup, real-signal
synchronization, the coverage rule — are in
[CONTRIBUTING.md](../../CONTRIBUTING.md#tests).
This page lists the fixture's entry points.

## Entry points

- **`projectFixture(options)`** registers its own `afterAll` and returns a project
  with a random short root (`/tmp/ac-*`, realpath'd, within the socket-path byte
  limit) and a leased webhook port, exported to sessions as `WEBHOOK_PORT`. Tests
  need no cleanup of their own.
- **Modes.** `repo` (the default) creates `.channels/{sources,dropbox}`, links
  `.channels/node_modules/auto-channels` to this repo and writes `sources`.
  `installed` creates nothing: the test runs the real `init` and `bun install`
  itself (e2e-27).
- **Seeds.** `seed('webhook' | 'cron' | 'filedrop')` returns the text of a shared
  one-line activation file in `fixtures/sources/`, a read-only input.
- **Sessions.** `project.session({ name?, env?, entry? })` owns one SDK client and
  adapter (`cwd` = the root). `connect()`/`close()` are explicit, so tests control
  connection order. `connectCount` counts the adapter's stderr
  `[adapter] connected to daemon` lines, one per (re)connect: the readiness signal.
  `notifications` keeps every channel notification's params and `received` their
  contents, in arrival order. `ready({ sources?, health? })` waits for a
  connection, then optionally for listed sources and the webhook's `/health`.
- **Other handles.** `paths` (run dir, socket, pid, status, log, sources, dropbox),
  `writeSource`/`removeSource`, `logCursor()` (only what was appended after it was
  taken), `daemonPid()`, `killDaemon(signal)` (resolves once that pid has exited) and
  `spawnAdapter()` (an owned direct subprocess for stdin/exit tests).
- **Synchronizers.** `waitFor`, `waitForSource` (a registry change, also a delivery
  barrier) and `listSourceNames`.
- **Budgets.** `READY_TIMEOUT_MS` (15 s) and `CLEANUP_TIMEOUT_MS` (5 s). Kept logs
  land in `/tmp/auto-channels-test-logs/<root>/`.

`harness.test.ts` is the fixture's own self-test.
