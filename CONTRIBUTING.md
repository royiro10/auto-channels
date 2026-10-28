# Contributing

## Setup and the gate

```bash
bun install
bun run typecheck && bun run lint && bun test     # must pass for every commit
```

The suite spawns real daemons and adapters and takes a few minutes. CI runs the same
gate on the minimum supported Bun (1.2.0) and the latest.

## Rules for changes

- **Every behaviour fix gets a test that fails first** against the unfixed code.
- **Preserve consumer-observable behaviour.** A break needs a clear complexity win and a
  CHANGELOG entry saying how to migrate.
- **Old adapters and daemons must keep interoperating.** A running session's adapter can
  meet a daemon from a newer install, so never assume a wire change is safe.
- **Request-shaped sources gate on sender identity**, localhost included — see
  [SECURITY.md](SECURITY.md).
- **Adapter stdout is MCP traffic**; diagnostics go to stderr.
- Prefer deletion and existing platform facilities. Before adding a runtime dependency
  (there are two), show that a smarter default can't cover the need.
- Extract a module only when its interface hides a coherent responsibility; testability
  alone isn't enough.
- Update the owning doc in the same change: consumer facts live in [docs/](docs/README.md).

## Code style

- **Comments explain what the code can't**: `/** … */` for a caller-facing contract,
  `/* … */` for implementation rationale beside the code that enforces it, `//` for one
  short fact. Document a contract once, at its owner. No restatements, caller lists or
  history — history lives in git.
- Every public symbol reachable through `package.json`'s `exports` has JSDoc. The
  `exports` map is the public boundary: enumerated entries only, no wildcards.
- Naming: `createX()` builds an object and starts nothing; `startX()` / `connectX()` /
  `runX()` begin ongoing work; `resolveX()` applies precedence and fails loudly;
  otherwise a plain precise verb.
- Validation errors name the knob the user actually set:
  `<knob> must <constraint>, got "<value>"` (`WEBHOOK_PORT must…` or
  `webhook({ port }) must…`).
- Tuning numbers are named constants with the unit in the name (`…_MS`, `…_BYTES`).

## Tests

- `test/unit/` tests each module at its own interface; `test/unit/builtins/` tests each
  builtin through the mock context, as a consumer would; `test/e2e/` drives real adapter
  processes over the MCP SDK against a real daemon and is the specification of
  consumer-visible behaviour. Fixture entry points: [test/e2e/README.md](test/e2e/README.md).
- Assert through an interface a real caller uses (MCP over stdio, files on disk, HTTP,
  log lines, a public helper), never an internal call sequence.
- **Never a fixed sleep as a positive precondition.** Synchronize on real signals: the
  adapter's `[adapter] connected to daemon` stderr line, `waitForSource`, `/health`, log
  cursors, pid changes, a nonce-bearing event. A "nothing arrives" window starts only
  after a positive barrier, with a comment justifying its length.
- A fake socket server in a test reads (or `resume()`s) every connection: on Linux an
  unread, paused socket never sees its peer close, so `server.close()` hangs.
- Public surface is imported by package name (`auto-channels/...`); internals by
  relative path. Directory watching goes through `shared/dirWatch.ts`, never raw
  `fs.watch` filenames.
- Each e2e `projectFixture()` is isolated (its own `/tmp/ac-*` root and leased port) and
  cleans up after itself. A runner killed with SIGKILL skips cleanup: check for leftover
  daemon/adapter processes and `/tmp/ac-*` roots. Stop daemons by their own pid, never by
  process-name pattern.
- No assertion is deleted or weakened unless the change names the surviving proof.
- A change touching timing passes repeated runs with every core saturated
  (`yes > /dev/null` × ncpu), not just one green run.
- **Known timing bets:** three filedrop unit cases still depend on time because nothing
  signals FSEvents' stream start — `startWatching`'s 150 ms beat after `startForTest`,
  and the two cases that stop 200 ms after a write. Add a source-side signal only if they
  flake.
