/*
 * ============================================================================
 * STARTER TEMPLATE — copy me to make a new event source.
 *
 * This file is DISABLED: a leading underscore makes the daemon skip it (that
 * is also how you pause any source without deleting it). Copy it to a name
 * without the underscore (`cp _starter.ts reminder.ts`) and it is LIVE the
 * moment you save: the daemon hot-reloads every add/edit/delete, with no
 * registration and no restart. Every non-underscore .ts file here is running.
 *
 * A source watches something outside the session (a webhook, a timer, a file,
 * an API you poll) and pushes it into the agent's transcript as a <channel>
 * tag. Events are fire-and-forget: with no session listening, one is dropped.
 *
 * BUILTINS: the common shapes ship with the package; enabling one is a
 * single-line file in this directory:
 *
 *   import { webhook } from 'auto-channels/builtins'
 *   export default webhook({ allowedSenders: ['dev'] })   // POST http://127.0.0.1:8788
 *
 *   import { cron } from 'auto-channels/builtins'
 *   export default cron({ intervalMs: 60_000 })   // ticks on a timer
 *
 *   import { filedrop } from 'auto-channels/builtins'
 *   export default filedrop()  // emits files dropped into ../dropbox/
 *
 * Optional settings: webhook port/path, cron intervalMs, filedrop dir, and
 * `name` for two instances side by side. Omitted ones come from the env block
 * of your adapter registration (.mcp.json or .pi/channels.json): WEBHOOK_PORT,
 * CRON_INTERVAL_MS, FILEDROP_DIR. webhook always requires allowedSenders.
 * Reference code: node_modules/auto-channels/src/builtins/.
 * ============================================================================
 */
import { createLogger } from 'auto-channels/shared/log.ts'
import type { Source } from 'auto-channels/shared/source.ts'

// Writes to the daemon's log (.channels/run/daemon.log), where console.log lands too.
const log = createLogger('starter')

const starter: Source = {
  // The `origin` on every event, and the name sessions subscribe by. Keep it short.
  name: 'starter',

  // REQUIRED: what this watches and what an event's `content` holds (autochannels_list_sources shows it).
  description: 'Starter template. Emits a single hello event when started; copy and edit me.',

  /*
   * OPTIONAL. Omit for events every session plausibly wants. Set false for a
   * source only some sessions want: it runs and is listed for everyone, but
   * delivers only to sessions that called autochannels_subscribe.
   * defaultSubscribed: false,
   */

  // Called on load (daemon startup, or right after you save). May be async.
  start(ctx) {
    /*
     * ctx.emit() is the whole job. `content` is the text the agent reads;
     * `meta` (optional) becomes tag attributes: string values, plain identifier
     * keys, `origin`/`source` reserved. A bad event is dropped loudly.
     */
    ctx.emit({ content: 'hello from the starter source', meta: { example_key: 'example_value' } })

    /*
     * Anything another process can reach (a webhook, even on localhost, where
     * any browser tab can POST; a chat callback) MUST gate on sender identity
     * before emit(), or anyone can inject text into the session. The gate is
     * yours to build (an allowed-senders list, a token, an HMAC check); see the
     * webhook builtin. Purely local triggers (timers, files) need none.
     */

    /*
     * A real source usually starts something long-lived, and RETURNS the
     * cleanup that stops it — called when this file is edited, deleted or
     * disabled, and when the daemon shuts down:
     *
     *   const id = setInterval(() => ctx.emit({ content: 'tick' }), 60_000)
     *   return () => clearInterval(id)
     */
    log('starter source ran -- copy this file to a non-underscore name to build your own')
    return () => {
      // nothing to clean up in this one-shot example
    }
  },
}

// Must be the default export — it's how the daemon finds the source.
export default starter

/*
 * ----------------------------------------------------------------------------
 * Testing your source (fast, no daemon/adapter/socket needed):
 *
 *   import { createMockContext, startForTest } from 'auto-channels/shared/testing.ts'
 *   const ctx = createMockContext()
 *   const stop = await startForTest(mySource, ctx)
 *   // ...trigger it...
 *   expect(ctx.emitted[0]?.content).toBe('what you expected')
 *   stop()
 *
 * The mock's emit() applies the daemon's own validation.
 * ----------------------------------------------------------------------------
 */
