# Writing your own source

Every `.ts` file in `.channels/sources/` is **active the moment it exists** — the
daemon watches the directory and hot-reloads on add/edit/delete. A leading underscore
(`_name.ts`) disables a file without deleting it. The scaffolded
`_starter.ts` is a fully-commented walkthrough: copy it to a non-underscore name to
start:

```ts
// .channels/sources/reminder.ts
import type { Source } from 'auto-channels/shared/source.ts'

const reminder: Source = {
  name: 'reminder',
  description: 'Ticks once a minute. content is always the fixed string "tick".', // required
  start(ctx) {
    const id = setInterval(() => ctx.emit({ content: 'tick' }), 60_000)
    return () => clearInterval(id) // cleanup — called on reload/remove/shutdown
  },
}
export default reminder
```

| Field | Required | Meaning |
|-------|----------|---------|
| `name` | yes | The `origin` on every emitted `<channel>` tag; the key sessions subscribe by. |
| `description` | **yes** | What it watches and what `content` contains. Without one the source fails to load, on purpose. |
| `defaultSubscribed` | no | `false` makes delivery opt-in; see [multiple sessions](#multiple-sessions). |
| `start(ctx)` | yes | Called on load, may be async. Returns the cleanup the daemon calls on edit, delete, disable and shutdown. |

`ctx.emit({ content, meta? })` sends an event: `content` is a string; `meta` is
optional, with string values and keys matching `/^[A-Za-z0-9_]+$/`. `origin` and
`source` are reserved meta keys — the adapter assigns `origin` last, so a source can't
spoof another. An invalid event is logged to `daemon.log` and dropped, never thrown
back into the source. Events are not queued: one emitted while no subscribed session
is connected is lost, so a source that must be heard emits on a trigger, not once at
startup.

Three rules that matter:

- **`description` is required** — it's what the `autochannels_list_sources` tool shows; a source
  without one fails to load, on purpose.
- **Gate anything another process can reach** — an HTTP endpoint, even on localhost
  (any browser tab can POST to it), or a chat callback. Build the gate into the source (an
  allowed-senders list, a token, an HMAC — whatever fits) and drop failures before `emit()`:
  an ungated endpoint lets anyone inject text into your session. Local triggers
  (timers, file watchers) don't need one. See the
  [security policy](../SECURITY.md#the-trust-boundary).
- **Return your cleanup.** Skipping it means the old interval/server/watcher keeps
  running alongside the new one after every hot-reload.

The [builtin implementations](../src/builtins/) are the reference code for
request-shaped, time-shaped and disk-shaped sources. Something wrong? See
[debugging](architecture.md#debugging).

## Testing

Test sources in milliseconds with the bundled mock context — same validation as the
real pipeline, no daemon or socket:

```ts
import { createMockContext, startForTest } from 'auto-channels/shared/testing.ts'

const ctx = createMockContext()
const stop = await startForTest(reminder, ctx)
// ...trigger it...
expect(ctx.emitted[0]?.content).toBe('tick')
stop()
```

See [`test/unit/builtins/`](../test/unit/builtins/) for complete examples of the pattern.

## Multiple sessions

Every session in a project shares one daemon (exactly one, even when two sessions
cold-start simultaneously). Each event is delivered once and teed to every
*subscribed* session — the default is subscribed-to-everything, so related sessions
coordinate with zero setup. Three MCP tools give each session control:
`autochannels_list_sources` (the live registry), and `autochannels_subscribe`/`autochannels_unsubscribe` (per-session,
survives daemon restarts). A source declaring `defaultSubscribed: false` is opt-in:
it runs for everyone but delivers only to sessions that subscribed — the shape for a
source one session creates for its own use: set it, then call `autochannels_subscribe`.

The rule: a session's explicit subscribe or unsubscribe for a name wins; otherwise the
emitting source's own `defaultSubscribed` decides. Another session may subscribe to an
opt-in source too — it is a delivery choice, not an ownership or trust boundary. Two
sources sharing a name each follow their own default, so give them distinct names or
matching defaults.
