/*
 * Exercises the webhook source's /health endpoint: GET /health must be an
 * unauthenticated liveness check (no X-Sender required), while POST /health
 * must NOT be special-cased — it goes through the exact same X-Sender gating
 * as any other path. Distinguishes "the health check is unauthenticated" from
 * "the /health path is special-cased for all methods."
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { type ProjectSession, projectFixture, type ReceivedEvent, seed, waitFor } from './helpers.ts'

const project = projectFixture({
  sources: { 'webhook.ts': seed('webhook'), 'cron.ts': seed('cron'), 'filedrop.ts': seed('filedrop') },
})

let session: ProjectSession
let received: ReceivedEvent[]

beforeAll(async () => {
  session = project.session()
  received = session.notifications
  await session.connect()
  await session.ready({ health: true })
}, 20_000)

describe('webhook /health endpoint', () => {
  test('GET /health returns 200 "ok" with no X-Sender header', async () => {
    const res = await fetch(`http://127.0.0.1:${project.port}/health`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  test('GET /health never produces a notification', async () => {
    const before = received.length
    await fetch(`http://127.0.0.1:${project.port}/health`)
    await new Promise(resolve => setTimeout(resolve, 300)) // give it a chance to (wrongly) arrive
    expect(received).toHaveLength(before)
  })

  test('POST /health without a valid sender is gated like any other path (403, no notification)', async () => {
    const before = received.length
    const res = await fetch(`http://127.0.0.1:${project.port}/health`, {
      method: 'POST',
      body: 'no sender header here',
    })
    expect(res.status).toBe(403)

    await new Promise(resolve => setTimeout(resolve, 300)) // give it a chance to (wrongly) arrive
    expect(received).toHaveLength(before)
  })

  test('POST /health with a valid sender is NOT special-cased: it is gated normally and produces a notification with meta.path "/health"', async () => {
    const before = received.length
    const res = await fetch(`http://127.0.0.1:${project.port}/health`, {
      method: 'POST',
      headers: { 'X-Sender': 'dev' },
      body: 'health post payload',
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')

    await waitFor(() => received.length > before, 5000, 'POST /health notification to arrive')
    const event = received[received.length - 1]
    expect(event?.content).toBe('health post payload')
    expect(event?.meta?.path).toBe('/health')
    expect(event?.meta?.method).toBe('POST')
    expect(event?.meta?.sender).toBe('dev')
  })
})
