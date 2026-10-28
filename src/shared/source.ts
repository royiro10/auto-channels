/**
 * What a source emits: one event, delivered to the session as a `<channel>` tag.
 * `meta` keys must match `/^[A-Za-z0-9_]+$/`; `origin` and `source` are reserved.
 * An invalid event is logged and dropped by the daemon, and thrown by the mock context.
 */
export interface ChannelEvent {
  content: string
  meta?: Record<string, string> | undefined
}

/**
 * A source's cleanup, called when its file is edited or removed and when the daemon
 * stops. It may be async: the daemon never awaits it, logs a throw or rejection, and
 * may exit before async cleanup finishes.
 */
export type StopFn = () => void | Promise<void>

/** What the daemon hands a source's `start()`. Deliberately small: a source needs no daemon internals. */
export interface SourceContext {
  /**
   * Deliver one event to every subscribed session, fire-and-forget. The daemon's emit never throws: an
   * invalid event is logged and dropped. Late calls (after stop) are still delivered.
   */
  emit(event: ChannelEvent): void
}

/**
 * The contract a consumer's `sources/*.ts` file default-exports. Every `.ts` file
 * there (minus a leading `_`) is loaded and hot-reloaded on each edit.
 */
export interface Source {
  /** Names the source in events (`origin`), the logs and autochannels_list_sources. Keep it unique. */
  name: string
  /**
   * Required, non-blank: what this source listens for and what an event's `content`
   * holds — so an agent can tell which loaded source to change without reading its code.
   */
  description: string
  /**
   * `false` = opt-in: the source runs and is listed for every session, but its events
   * reach only sessions that called autochannels_subscribe. Omitted or `true` = delivered
   * to every session that has not unsubscribed. A delivery default, not ownership or trust.
   */
  defaultSubscribed?: boolean
  /**
   * Start listening and return the cleanup, if any. A throw or rejection fails only this
   * source (logged); an uncaught throw from a later callback crashes and respawns the daemon.
   */
  start(ctx: SourceContext): StopFn | undefined | Promise<StopFn | undefined>
}
