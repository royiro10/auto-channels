/*
 * Pins the public test helpers consumers use for their own sources: the mock
 * context records valid events and throws the daemon's message for an invalid
 * one; startForTest passes a context (a fresh one by default), awaits start()
 * and always returns a callable stop.
 */
import { describe, expect, test } from 'bun:test'
import type { Source, SourceContext } from '../../src/shared/source.ts'
import { createMockContext, startForTest } from '../../src/shared/testing.ts'

describe('createMockContext', () => {
  test('emit() collects events in order, including meta', () => {
    const ctx = createMockContext()
    ctx.emit({ content: 'first' })
    ctx.emit({ content: 'second', meta: { chat_id: '42' } })
    expect(ctx.emitted).toEqual([{ content: 'first' }, { content: 'second', meta: { chat_id: '42' } }])
  })

  test("emit() applies the daemon's event rule: a reserved meta key throws, nothing is recorded", () => {
    /*
     * One case proves the mock delegates to parseEvent (shared/protocol.ts);
     * the full rejection matrix lives in protocol.test.ts.
     */
    const ctx = createMockContext()
    expect(() => ctx.emit({ content: 'hi', meta: { origin: 'spoofed' } })).toThrow(
      'invalid channel meta key "origin": reserved, set by the adapter itself',
    )
    expect(ctx.emitted).toEqual([])
  })
})

describe('startForTest', () => {
  test('passes the context through to start() and returns its emitted events via ctx', async () => {
    const source: Source = {
      name: 'fixture',
      description: 'test fixture',
      start(ctx) {
        ctx.emit({ content: 'hello from fixture' })
      },
    }
    const ctx = createMockContext()
    await startForTest(source, ctx)
    expect(ctx.emitted).toEqual([{ content: 'hello from fixture' }])
  })

  test('creates a default context that behaves like a real mock, not just a defined placeholder', async () => {
    /*
     * toBeDefined() alone wouldn't catch a broken default (e.g. `{}` cast as
     * MockSourceContext, which is non-null but has no working methods) --
     * verify the default context actually behaves like createMockContext()'s
     * real emit(), not merely that something non-null was passed.
     */
    let receivedCtx: SourceContext | undefined
    const source: Source = {
      name: 'fixture',
      description: 'test fixture',
      start(ctx) {
        receivedCtx = ctx
      },
    }
    await startForTest(source)
    expect(() => receivedCtx?.emit({ content: 'probe' })).not.toThrow()
    expect(() => receivedCtx?.emit({ content: 'bad', meta: { origin: 'x' } })).toThrow(/reserved/)
  })

  test("returns the source's own stop function when it provides one", async () => {
    let stopped = false
    const source: Source = {
      name: 'fixture',
      description: 'test fixture',
      start() {
        return () => {
          stopped = true
        }
      },
    }
    const stop = await startForTest(source)
    expect(stopped).toBe(false)
    stop()
    expect(stopped).toBe(true)
  })

  test('types its result as the StopFn contract, so an async stop can be awaited (checked by typecheck)', () => {
    // A compile error while startForTest returned Promise<() => void>: that stop's result admitted no promise.
    const admitsAPromise: Promise<void> extends ReturnType<Awaited<ReturnType<typeof startForTest>>> ? true : false =
      true
    expect(admitsAPromise).toBe(true)
  })

  test('returns a safe no-op stop function when the source does not provide one', async () => {
    const source: Source = {
      name: 'fixture',
      description: 'test fixture',
      start() {
        // returns undefined
      },
    }
    const stop = await startForTest(source)
    expect(() => stop()).not.toThrow()
  })

  test('awaits an async start() before resolving', async () => {
    let started = false
    const source: Source = {
      name: 'fixture',
      description: 'test fixture',
      async start() {
        await new Promise(resolve => setTimeout(resolve, 10))
        started = true
      },
    }
    await startForTest(source)
    expect(started).toBe(true)
  })
})
