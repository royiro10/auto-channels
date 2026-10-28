import { z } from 'zod'
import type { ChannelEvent } from './source.ts'

// Declared against the public type, so the schema and source.ts's ChannelEvent can never drift apart.
const ChannelEventSchema = z.object({
  content: z.string(),
  meta: z.record(z.string(), z.string()).optional(),
}) satisfies z.ZodType<ChannelEvent>

// daemon -> adapter frames

/** An event from a source, destined to become one `notifications/claude/channel`. */
const EventFrameSchema = ChannelEventSchema.extend({
  type: z.literal('event'),
  source: z.string(),
})

/** One loaded source, as the daemon's registry describes it. */
const SourceInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  file: z.string(),
  // false = opt-in: listed for every session, delivered only to sessions that subscribed (see wants).
  defaultSubscribed: z.boolean(),
})
export type SourceInfo = z.infer<typeof SourceInfoSchema>

/**
 * The whole source registry, pushed to every adapter on connect and after every
 * change. Pushed, not requested: no request/reply correlation on the socket, and
 * the adapter's mirror answers autochannels_list_sources synchronously.
 */
const SourcesFrameSchema = z.object({
  type: z.literal('sources'),
  sources: z.array(SourceInfoSchema),
})

const DaemonFrameSchema = z.discriminatedUnion('type', [EventFrameSchema, SourcesFrameSchema])
export type DaemonFrame = z.infer<typeof DaemonFrameSchema>

// adapter -> daemon frames

/**
 * A session's whole subscription intent, replacing what the daemon held for this
 * connection. Declarative rather than add/remove messages, so it is idempotent and
 * replayable on reconnect; a name in both lists counts as subscribed.
 */
const SubscriptionsFrameSchema = z.object({
  type: z.literal('subscriptions'),
  /** Names the session in the daemon's log: the host's AGENT_SESSION_ID when set, else a per-process UUID. */
  sessionId: z.string(),
  subscribed: z.array(z.string()),
  unsubscribed: z.array(z.string()),
})
export type SubscriptionsFrame = z.infer<typeof SubscriptionsFrameSchema>

const AdapterFrameSchema = z.discriminatedUnion('type', [SubscriptionsFrameSchema])
export type AdapterFrame = z.infer<typeof AdapterFrameSchema>

/*
 * Claude Code turns each `meta` entry into a `<channel>` tag attribute and
 * silently drops any key that isn't a plain identifier — validate up front
 * so a bad key fails loudly here instead of quietly vanishing downstream.
 */
const META_KEY_PATTERN = /^[A-Za-z0-9_]+$/

/*
 * `origin` is the adapter's attribution, assigned last over any meta — a source
 * setting it is a spoofing attempt, rejected loudly rather than overwritten.
 * `source` is the tag attribute Claude Code sets from the MCP server name.
 */
const RESERVED_META_KEYS = new Set(['origin', 'source'])

/** The one source-event rule, shared by the daemon and createMockContext. Throws naming the first violation. */
export function parseEvent(value: unknown): ChannelEvent {
  const event = ChannelEventSchema.parse(value)
  for (const key of Object.keys(event.meta ?? {})) {
    if (RESERVED_META_KEYS.has(key)) {
      throw new Error(`invalid channel meta key "${key}": reserved, set by the adapter itself`)
    }
    if (!META_KEY_PATTERN.test(key)) {
      throw new Error(`invalid channel meta key "${key}": must match ${META_KEY_PATTERN}`)
    }
  }
  return event
}

/** A session's explicit choices: true = subscribed, false = muted; absent = the source's own default. */
export type Intent = ReadonlyMap<string, boolean>

/**
 * The one delivery rule (daemon filtering, the adapter's `subscribed` flag): an
 * explicit choice beats the source's default. No intent at all (a connection that
 * never sent a subscriptions frame) gets every default-subscribed source.
 */
export function wants(intent: Intent | undefined, source: string, defaultSubscribed: boolean): boolean {
  return intent?.get(source) ?? defaultSubscribed
}

/** One frame as one NDJSON line. Serializes only: events are validated by parseEvent before this. */
export function encodeFrame(frame: DaemonFrame | AdapterFrame): string {
  return `${JSON.stringify(frame)}\n`
}

/**
 * A socket `'data'` handler that yields each complete, validated frame from
 * the other side. Bytes are split on `\n` (0x0a, never a UTF-8 continuation
 * byte) before decoding, so a character split across two reads survives
 *; an unterminated tail waits for its newline. Each line
 * stands alone: a malformed or wrong-direction one goes to `onError` with its
 * raw text and costs none of its siblings. A trailing `\r` is JSON whitespace.
 */
export function createFrameReader(
  from: 'daemon',
  onFrame: (frame: DaemonFrame) => void,
  onError: (message: string) => void,
): (chunk: Uint8Array) => void
export function createFrameReader(
  from: 'adapter',
  onFrame: (frame: AdapterFrame) => void,
  onError: (message: string) => void,
): (chunk: Uint8Array) => void
export function createFrameReader(
  from: 'daemon' | 'adapter',
  onFrame: (frame: DaemonFrame & AdapterFrame) => void, // never: the overloads above carry the real types
  onError: (message: string) => void,
): (chunk: Uint8Array) => void {
  const schema = from === 'daemon' ? DaemonFrameSchema : AdapterFrameSchema
  // The unterminated line so far, as copied chunks: concatenated once, when its newline arrives.
  let pending: Uint8Array[] = []
  return chunk => {
    let start = 0
    for (let end = chunk.indexOf(0x0a); end >= 0; end = chunk.indexOf(0x0a, start)) {
      pending.push(chunk.subarray(start, end))
      const line = Buffer.concat(pending).toString('utf8')
      pending = []
      start = end + 1
      if (line.trim() === '') continue
      let frame: DaemonFrame | AdapterFrame
      try {
        frame = schema.parse(JSON.parse(line))
      } catch (err) {
        onError(`${err} (raw: ${line})`)
        continue
      }
      // Outside the try: a caller's own exception is never reported as a malformed frame.
      onFrame(frame as DaemonFrame & AdapterFrame)
    }
    if (start < chunk.length) pending.push(Buffer.from(chunk.subarray(start)))
  }
}
