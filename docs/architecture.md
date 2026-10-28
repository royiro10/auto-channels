# Architecture and debugging

## The daemon, in five lines

One persistent daemon per project serves every session; artifacts (socket, pidfile,
`daemon.log`, `daemon.status.json`) live in `.channels/run/`. **Read `daemon.log`
first when debugging** — source load failures and dropped events land there. For an
unattended deployment, `daemon.status.json` is an external liveness/health surface —
pid, up-since, and every source's last-emit time and last crash — pollable by a watchdog with a
plain file read, no MCP tool call needed. Sources
hot-reload; the daemon itself only needs a restart after updating the *package's*
code (see [restarting the daemon](#restarting-the-daemon)). Left
with no sessions, it exits by itself after a grace window — no orphans. Two projects
on one machine get separate daemons sharing no state; they do share TCP ports, so two
projects enabling `webhook()` on one port collide and the loser's webhook fails to load
until it picks another port.

The adapter (one per session, the MCP server the host spawns) connects to the daemon
over `.channels/run/daemon.sock`, spawning it if absent. A startup lock lets exactly one
daemon win when several sessions cold-start at once. On every reconnect the adapter
replays its session's subscriptions, so they survive a daemon restart; events fired
during the outage do not. A source callback's uncaught throw crashes the daemon, which
logs which file did it and records it as that source's `lastError`; the next adapter
connection respawns a fresh daemon.

## Debugging

1. **Read `.channels/run/daemon.log` first.** The daemon runs fully detached;
   this file is the only place its diagnostics go: load failures
   (`failed to load <file>: …`), dropped invalid events, malformed frames, and
   crashes. A source whose own callback threw is named:
   `source <file> crashed the daemon: <stack>`; the adapter respawns the daemon.
2. Call `autochannels_list_sources` (or `ls .channels/sources/`) — that IS the registry.
   Check the source appears, its description is right, and this session's
   `subscribed` flag is true ([multiple sessions](sources.md#multiple-sessions)). No
   live session to call it from (an unattended deployment)? Read
   `.channels/run/daemon.status.json` instead — pid, up-since, and per source
   `lastEmitAt` and `lastError` (`{ at, message }` of the last crash that file
   caused, kept across the respawn), no MCP tool needed.
3. Common causes, in order:
   - Missing/empty `description` → the source fails to load, on purpose.
   - No `export default` → not recognized as a source.
   - Leading underscore in the filename → deliberately disabled.
   - Sender not in the webhook's `allowedSenders` → 403 (the gate lives in
     the activation file).
   - Emitted a non-string `content` or bad `meta` → dropped loudly, see the
     log ([event rules](sources.md#writing-your-own-source)).
   - Emit fired before any session connected → events aren't queued, so it was dropped.
4. Edit the file and save — hot reload applies immediately; watch the log.
5. Reproduce in isolation with the [mock context](sources.md#testing).

Log from sources with `createLogger('name')` (or `console.log`): both land in
`daemon.log`. Only the adapter's stdout is reserved, for MCP traffic.

### Events stopped reaching a session (nothing wrong with the source)

If a source is healthy (`daemon.log` shows `event from <source>: ...`) but a
session stopped seeing `<channel>` tags, suspect the session→daemon link, not
the source — hard-won lessons from a real deployment:

- **`autochannels_list_sources` showing `subscribed: true` is NOT proof of delivery** —
  it's computed adapter-side from the session's intent and says nothing about
  a live socket. Emit a probe or read the status file instead.
- **Read `.channels/run/daemon.status.json`'s `connectedClients`.** A healthy
  daemon with `connectedClients: 0` (or fewer than your live sessions) means
  an adapter went zombie — alive but holding no socket, so events drop into a
  void. Fix: restart the session (exit, relaunch `claude
  --dangerously-load-development-channels server:auto-channels`); a fresh adapter
  reconnects, and `connectedClients` going back up confirms the link is live.
- **A newly-added env var reads as unset?** A running daemon's env is frozen
  at spawn ([configuration](configuration.md)) — restart the daemon.

## Restarting the daemon

You don't need to for:

- Source changes, including gate edits in an activation file: hot-reloaded
  automatically. (A source's local helper module is the exception — see the
  [known limitations](#known-limitations).)
- Abandoned daemons: idle shutdown exits them gracefully after ~60s with zero
  connected sessions.

You do after:

- Updating the **package's own** code while sessions are still connected — a
  running daemon keeps executing the old code.
- Changing the env block of the adapter registration: a running daemon's env is
  fixed at spawn ([configuration](configuration.md)).
- Editing a source's helper module (transitive imports are not reloaded).

```bash
kill $(cat .channels/run/daemon.pid)
```

Safe any time: the daemon runs its stop sequence (every source's `stop()` is
invoked, socket/pidfile/status file/lock removed) and the next adapter
connection attempt respawns a fresh one. Adapters replay their subscriptions on
reconnect.

- Never `pkill` by pattern — other projects' daemons look identical; kill
  only the pid from this project's own pidfile.
- The daemon is shared: restarting it briefly interrupts every session in
  the project, and each adapter reconnects within its 5s backoff.

## Known limitations

- **Late emits.** An instance's emits after its `stop()` (or from filedrop's
  still-pending checks) are delivered, not cancelled.
- **Overlapping instances.** When a `start()` outlasts the 150 ms reload debounce,
  old and new instances of one file briefly run together.
- **Hung start.** A `start()` that never resolves leaves an instance no reload can
  stop; if it claimed a resource first (a port), the fix fails until the daemon
  restarts.
- **Transitive imports are not reloaded.** Editing a source's helper module has no
  effect until the source file itself changes or the daemon restarts.
- **Async cleanup may be cut off.** `stop()` is never awaited; at shutdown the
  process may exit before an async cleanup finishes.
- **Log rotation only at spawn.** `daemon.log` is rotated only when an adapter spawns
  a daemon, so a long-running daemon's log grows without bound; a daemon still
  starting up can have its log rotated under it.
- **A deleted file's last load.** A source file deleted mid-load logs one
  `failed to load` line before the deletion retires it.
- **A reused pid, or a contender killed mid-steal,** can leave the startup lock looking
  held; no daemon starts until `.channels/run/` is cleared.
- **A drop before initialization, on Bun 1.2.x.** The adapter notices a daemon that
  dropped before MCP initialization only at initialization.
- **Unattributed crashes.** A crash whose stack has no frame under `sources/` (a
  non-`Error` throw, a shared helper outside it, a symlinked source) is logged as
  `daemon crashed:` with no `lastError`.
- **Crash semantics rest on Bun.** A source's unhandled rejection exits the daemon
  because Bun exits on one.
- **Reload memory.** Memory plateaus across reloads for ordinary sources; for a very
  large source (around 200 KB) it was not measured to.

## Where the depth lives

- **[CONTRIBUTING.md](../CONTRIBUTING.md)** and **[AGENTS.md](../AGENTS.md)** — how to
  change this code. This repo deliberately doesn't register the channel for its own
  sessions: to drive it from a real session, scaffold a scratch consumer anywhere
  (`auto-channels init` after `bun link`, per the [Quickstart](../README.md#quickstart)).
- **[How Claude Code channels behave](claude-code-channels.md)** — the platform facts
  this design rests on.
- **[test/e2e/README.md](../test/e2e/README.md)** — the e2e fixture's entry points.
