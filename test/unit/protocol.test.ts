import { describe, expect, test } from 'bun:test'
import { createFrameReader, encodeFrame, parseEvent, wants } from '../../src/shared/protocol.ts'

/** A reader for one direction that collects what it yields; string chunks are UTF-8 encoded. */
function reader(from: 'daemon' | 'adapter') {
  const frames: unknown[] = []
  const errors: string[] = []
  const onFrame = (frame: unknown) => frames.push(frame)
  const onError = (message: string) => errors.push(message)
  const read =
    from === 'daemon' ? createFrameReader('daemon', onFrame, onError) : createFrameReader('adapter', onFrame, onError)
  return {
    frames,
    errors,
    push: (chunk: string | Uint8Array) => read(typeof chunk === 'string' ? Buffer.from(chunk) : chunk),
  }
}

const event = (source: string, content: unknown) => JSON.stringify({ type: 'event', source, content })

describe('parseEvent', () => {
  test('returns a valid event with identifier-only meta keys', () => {
    expect(parseEvent({ content: 'hi', meta: { chat_id: '1', severity2: 'high' } })).toEqual({
      content: 'hi',
      meta: { chat_id: '1', severity2: 'high' },
    })
  })

  test('returns a valid event without meta', () => {
    expect(parseEvent({ content: 'hello' })).toEqual({ content: 'hello' })
  })

  test('rejects keys with hyphens', () => {
    expect(() => parseEvent({ content: 'hi', meta: { 'chat-id': '1' } })).toThrow(
      'invalid channel meta key "chat-id": must match /^[A-Za-z0-9_]+$/',
    )
  })

  test('rejects keys with spaces or punctuation', () => {
    expect(() => parseEvent({ content: 'hi', meta: { 'a key!': '1' } })).toThrow('invalid channel meta key "a key!"')
  })

  test('rejects "origin" even though it is a valid identifier', () => {
    /*
     * Reserved: the adapter assigns `origin` (last) from which source
     * produced the event, so an event's own meta setting the same key is a
     * spoofing attempt, rejected loudly -- see the comment on
     * RESERVED_META_KEYS in shared/protocol.ts.
     */
    expect(() => parseEvent({ content: 'hi', meta: { origin: 'spoofed' } })).toThrow(
      'invalid channel meta key "origin": reserved, set by the adapter itself',
    )
  })

  test('rejects "source" even though it is a valid identifier', () => {
    /*
     * Reserved: Claude Code sets the <channel> tag's own `source` attribute
     * automatically from the MCP server's name, never from meta -- the exact
     * reason this project uses `origin` for its own attribution instead. A
     * source's meta carrying its own `source` key would collide with that
     * platform-reserved attribute name.
     */
    expect(() => parseEvent({ content: 'hi', meta: { source: 'spoofed' } })).toThrow(
      'invalid channel meta key "source": reserved, set by the adapter itself',
    )
  })

  test('rejects non-string content instead of crashing', () => {
    // A source is plain JavaScript at runtime; nothing stops it from bypassing the TypeScript contract.
    expect(() => parseEvent({ content: 123 })).toThrow(/content/)
  })

  test('rejects a non-string meta value', () => {
    // The key is fine; the value violates Record<string, string> and must not reach the wire.
    expect(() => parseEvent({ content: 'hi', meta: { chat_id: 42 } })).toThrow(/chat_id/)
  })

  test('rejects missing content entirely', () => {
    expect(() => parseEvent({})).toThrow(/content/)
  })
})

describe('createFrameReader', () => {
  test('yields several complete frames arriving in one chunk', () => {
    const r = reader('daemon')
    r.push(`${event('a', '1')}\n${event('b', '2')}\n`)
    expect(r.frames).toEqual([
      { type: 'event', source: 'a', content: '1' },
      { type: 'event', source: 'b', content: '2' },
    ])
    expect(r.errors).toEqual([])
  })

  test('holds back an incomplete line across chunks with no newline yet', () => {
    const r = reader('daemon')
    const line = `${event('a', 'partial line')}\n`
    r.push(line.slice(0, 10))
    expect(r.frames).toEqual([])
    r.push(line.slice(10))
    expect(r.frames).toEqual([{ type: 'event', source: 'a', content: 'partial line' }])
  })

  test('never emits an unterminated tail', () => {
    const r = reader('daemon')
    r.push(event('a', 'no newline yet'))
    expect(r.frames).toEqual([])
    expect(r.errors).toEqual([])
  })

  test('reconstructs a multi-byte UTF-8 character split exactly across two chunks', () => {
    /*
     * Decoding each chunk to utf8 before concatenating turns a split emoji
     * into replacement characters that can never be recovered, even once the
     * rest of its bytes arrive.
     */
    const content = 'before 🎉 after'
    const bytes = Buffer.from(`${event('a', content)}\n`, 'utf8')
    const splitPoint = bytes.indexOf(Buffer.from('🎉', 'utf8')) + 2 // splits the emoji's 4-byte sequence in half
    const r = reader('daemon')
    r.push(bytes.subarray(0, splitPoint))
    expect(r.frames).toEqual([])
    r.push(bytes.subarray(splitPoint))
    expect(r.errors).toEqual([])
    expect(r.frames).toEqual([{ type: 'event', source: 'a', content }])
  })

  test('reconstructs multi-byte characters delivered one byte at a time', () => {
    const content = '🎉'.repeat(3)
    const bytes = Buffer.from(`${event('a', content)}\n`, 'utf8')
    const r = reader('daemon')
    for (let i = 0; i < bytes.length; i++) r.push(bytes.subarray(i, i + 1))
    expect(r.frames).toEqual([{ type: 'event', source: 'a', content }])
  })

  test('a large frame split into many chunks decodes intact, with its sibling after it', () => {
    const content = 'x🎉'.repeat(200_000) // ~1 MB of mixed-width UTF-8
    const bytes = Buffer.from(`${event('a', content)}\n${event('b', 'next')}\n`, 'utf8')
    const r = reader('daemon')
    for (let i = 0; i < bytes.length; i += 1000) r.push(bytes.subarray(i, i + 1000))
    expect(r.errors).toEqual([])
    expect(r.frames).toEqual([
      { type: 'event', source: 'a', content },
      { type: 'event', source: 'b', content: 'next' },
    ])
  })

  test('skips blank and whitespace-only lines', () => {
    const r = reader('daemon')
    r.push(`\n${event('a', '1')}\n  \n\n`)
    expect(r.frames).toEqual([{ type: 'event', source: 'a', content: '1' }])
    expect(r.errors).toEqual([])
  })

  test('tolerates CRLF line endings (a trailing \\r is JSON whitespace)', () => {
    const r = reader('daemon')
    r.push(`${event('a', '1')}\r\n`)
    expect(r.frames).toEqual([{ type: 'event', source: 'a', content: '1' }])
    expect(r.errors).toEqual([])
  })

  test('reports a malformed line with its raw text instead of throwing or dropping it silently', () => {
    const r = reader('daemon')
    r.push('not json\n')
    expect(r.frames).toEqual([])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toContain('(raw: not json)')
  })

  test('a malformed line does not cost its valid siblings in the same chunk', () => {
    /*
     * A source emitting several events in a tight loop can easily have
     * multiple writes coalesce into one socket read -- one bad frame in that
     * batch must not silently drop the unrelated good ones alongside it.
     */
    const r = reader('daemon')
    r.push(`${event('x', 'good-1')}\n${event('x', 123)}\nnot json\n${event('x', 'good-2')}\n`)
    expect(r.frames).toEqual([
      { type: 'event', source: 'x', content: 'good-1' },
      { type: 'event', source: 'x', content: 'good-2' },
    ])
    expect(r.errors).toHaveLength(2)
  })

  test('an untagged legacy-shape line is rejected, not silently misparsed', () => {
    /*
     * The discriminated union requires the type tag -- an old daemon writing
     * untagged frames to a new adapter surfaces as a logged decode error,
     * not a silent misread.
     */
    const r = reader('daemon')
    r.push(`${JSON.stringify({ source: 'a', content: '1' })}\n`)
    expect(r.frames).toEqual([])
    expect(r.errors).toHaveLength(1)
  })

  test('a frame from the other direction is rejected on each reader', () => {
    // The two directions have disjoint frame types: a crossed wire is a decode error, never a silent misread.
    const fromDaemon = reader('adapter')
    fromDaemon.push(`${event('a', '1')}\n`)
    expect(fromDaemon.frames).toEqual([])
    expect(fromDaemon.errors).toHaveLength(1)

    const fromAdapter = reader('daemon')
    fromAdapter.push(`${JSON.stringify({ type: 'subscriptions', sessionId: 's', subscribed: [], unsubscribed: [] })}\n`)
    expect(fromAdapter.frames).toEqual([])
    expect(fromAdapter.errors).toHaveLength(1)
  })

  test('a throwing onFrame propagates to the caller and is not reported as a malformed frame', () => {
    const errors: string[] = []
    const read = createFrameReader(
      'daemon',
      () => {
        throw new Error('caller bug')
      },
      message => errors.push(message),
    )
    expect(() => read(Buffer.from(`${event('a', '1')}\n`))).toThrow('caller bug')
    expect(errors).toEqual([])
  })
})

describe('encodeFrame', () => {
  test('produces a single newline-terminated JSON line', () => {
    const line = encodeFrame({ type: 'event', source: 'webhook', content: 'hello' })
    expect(line).toBe('{"type":"event","source":"webhook","content":"hello"}\n')
  })

  test('content with embedded literal newlines stays one line and round-trips intact', () => {
    /*
     * NDJSON is only safe if a newline inside content never appears as a raw
     * byte in the frame, only as the escaped sequence within the JSON string.
     * A multi-line webhook body or CI log snippet is an ordinary use case.
     */
    const frame = { type: 'event' as const, source: 'webhook', content: 'line one\nline two\nline three' }
    const line = encodeFrame(frame)
    expect(line.split('\n')).toHaveLength(2) // the one whole line + the trailing empty string
    const r = reader('daemon')
    r.push(line)
    expect(r.errors).toEqual([])
    expect(r.frames).toEqual([frame])
  })
})

describe('old-format frames (the mixed-version proof)', () => {
  /*
   * Each literal is exactly what the older per-type encoders wrote. The
   * reader decodes it, and encodeFrame reproduces it byte for byte, so old
   * and new adapters and daemons interoperate on the unchanged wire.
   */
  const EVENT = '{"type":"event","source":"webhook","content":"hi","meta":{"sender":"dev"}}\n'
  const SOURCES =
    '{"type":"sources","sources":[{"name":"webhook","description":"HTTP listener","file":"webhook.ts","defaultSubscribed":true},' +
    '{"name":"private","description":"opt-in source","file":"private.ts","defaultSubscribed":false}]}\n'
  const SUBSCRIPTIONS =
    '{"type":"subscriptions","sessionId":"abc-123","subscribed":["private"],"unsubscribed":["cron"]}\n'

  test('an event frame with meta', () => {
    const frame = { type: 'event' as const, source: 'webhook', content: 'hi', meta: { sender: 'dev' } }
    const r = reader('daemon')
    r.push(EVENT)
    expect(r.frames).toEqual([frame])
    expect(encodeFrame(frame)).toBe(EVENT)
  })

  test('a sources frame with every registry field', () => {
    const frame = {
      type: 'sources' as const,
      sources: [
        { name: 'webhook', description: 'HTTP listener', file: 'webhook.ts', defaultSubscribed: true },
        { name: 'private', description: 'opt-in source', file: 'private.ts', defaultSubscribed: false },
      ],
    }
    const r = reader('daemon')
    r.push(SOURCES)
    expect(r.frames).toEqual([frame])
    expect(encodeFrame(frame)).toBe(SOURCES)
  })

  test('a subscriptions frame', () => {
    const frame = {
      type: 'subscriptions' as const,
      sessionId: 'abc-123',
      subscribed: ['private'],
      unsubscribed: ['cron'],
    }
    const r = reader('adapter')
    r.push(SUBSCRIPTIONS)
    expect(r.frames).toEqual([frame])
    expect(encodeFrame(frame)).toBe(SUBSCRIPTIONS)
  })
})

describe('wants', () => {
  /*
   * The pub/sub delivery rule -- the daemon filters broadcast with it and the
   * adapter's autochannels_list_sources computes its `subscribed` flag with
   * it. Combinations are cheap to enumerate here and expensive in an e2e.
   */
  test('a default-subscribed source is delivered to a connection with no explicit intent', () => {
    /*
     * The backwards-compatibility case: a connection that never sends a
     * subscriptions frame (old adapter, raw test socket) receives exactly
     * what every connection received before pub/sub existed.
     */
    expect(wants(undefined, 'webhook', true)).toBe(true)
    expect(wants(new Map(), 'webhook', true)).toBe(true)
  })

  test('an opt-in (defaultSubscribed: false) source is NOT delivered without an explicit subscribe', () => {
    expect(wants(undefined, 'private', false)).toBe(false)
    expect(wants(new Map(), 'private', false)).toBe(false)
  })

  test('an explicit subscribe delivers an opt-in source', () => {
    expect(wants(new Map([['private', true]]), 'private', false)).toBe(true)
  })

  test('an explicit unsubscribe mutes a default-subscribed source', () => {
    expect(wants(new Map([['cron', false]]), 'cron', true)).toBe(false)
  })

  test('subscribing to a source you would get anyway is harmless (idempotent)', () => {
    expect(wants(new Map([['webhook', true]]), 'webhook', true)).toBe(true)
  })

  test('intent for one source never affects another', () => {
    const intent = new Map([
      ['private', true],
      ['cron', false],
    ])
    expect(wants(intent, 'webhook', true)).toBe(true)
    expect(wants(intent, 'other_optin', false)).toBe(false)
  })
})
