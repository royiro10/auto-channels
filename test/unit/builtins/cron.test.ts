/*
 * The cron builtin's zero-arg instance and its factory options, using the same mock-context pattern a consumer uses
 * for their own sources: a mock SourceContext instead of a real daemon + adapter + socket. No
 * subprocess, no port, no CHANNEL_RUN_DIR — just the source and its contract.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createMockContext, startForTest, waitFor } from 'auto-channels/shared/testing.ts'
import { cron as cronFactory } from '../../../src/builtins/index.ts'

const cron = cronFactory()

let stop: (() => void) | undefined

afterEach(() => {
  stop?.()
  stop = undefined
  delete process.env.CRON_INTERVAL_MS
})

describe('cron source', () => {
  test('ticks on the configured interval with an increasing timestamp', async () => {
    process.env.CRON_INTERVAL_MS = '20'
    const ctx = createMockContext()
    stop = await startForTest(cron, ctx)

    await waitFor(() => ctx.emitted.length >= 3, 2000, 'three cron ticks')

    expect(ctx.emitted.length).toBeGreaterThanOrEqual(3)
    for (const event of ctx.emitted) expect(event.content).toMatch(/^cron tick at .+/)

    const timestamps = ctx.emitted.map(event => Date.parse(event.content.replace('cron tick at ', '')))
    expect(timestamps[1]).toBeGreaterThanOrEqual(timestamps[0] ?? 0)
    expect(timestamps[2]).toBeGreaterThanOrEqual(timestamps[1] ?? 0)
  })

  test('stop() clears the interval so no further ticks arrive', async () => {
    process.env.CRON_INTERVAL_MS = '20'
    const ctx = createMockContext()
    stop = await startForTest(cron, ctx)

    await new Promise(resolve => setTimeout(resolve, 60))
    expect(ctx.emitted.length).toBeGreaterThan(0)

    stop()
    stop = undefined
    const countAtStop = ctx.emitted.length
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(ctx.emitted.length).toBe(countAtStop)
  })

  test('rejects a non-positive-integer CRON_INTERVAL_MS', async () => {
    process.env.CRON_INTERVAL_MS = 'not-a-number'
    await expect(startForTest(cron, createMockContext())).rejects.toThrow(/CRON_INTERVAL_MS/)
  })
})

describe('cron factory', () => {
  test('intervalMs option beats the CRON_INTERVAL_MS env var', async () => {
    process.env.CRON_INTERVAL_MS = 'not-even-a-number' // would throw if consulted
    const ctx = createMockContext()
    stop = await startForTest(cronFactory({ intervalMs: 20 }), ctx)

    await waitFor(() => ctx.emitted.length >= 2)
    expect(ctx.emitted[0]?.content).toMatch(/^cron tick at .+/)
  })

  test('an invalid intervalMs option fails naming the option', async () => {
    await expect(startForTest(cronFactory({ intervalMs: 0 }), createMockContext())).rejects.toThrow(
      /cron\(\{ intervalMs \}\) must be a positive integer/,
    )
  })

  test('two named instances of the same builtin coexist', async () => {
    const fast = cronFactory({ name: 'fast-cron', intervalMs: 20 })
    const slow = cronFactory({ name: 'slow-cron', intervalMs: 60_000 })
    expect(fast.name).toBe('fast-cron')
    expect(slow.name).toBe('slow-cron')

    const fastCtx = createMockContext()
    const slowCtx = createMockContext()
    const stopFast = await startForTest(fast, fastCtx)
    const stopSlow = await startForTest(slow, slowCtx)
    stop = () => {
      stopFast()
      stopSlow()
    }

    await waitFor(() => fastCtx.emitted.length >= 2)
    expect(slowCtx.emitted).toHaveLength(0) // its hour-long interval never fired
  })

  test('an empty name option fails at factory time — it is the subscription key and log scope', () => {
    expect(() => cronFactory({ name: '  ' })).toThrow(/cron\(\{ name \}\) must not be empty/)
  })
})
