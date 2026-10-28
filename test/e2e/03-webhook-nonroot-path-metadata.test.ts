/*
 * Pins the webhook's path metadata: a POST (or other method) to a non-root
 * path surfaces that path verbatim in meta.path (query string stripped), with
 * meta.method, meta.sender and meta.origin set as for the root path.
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

describe('webhook source: non-root path metadata', () => {
  test('POST to a non-root path surfaces that path, method, origin, sender and body', async () => {
    const before = received.length
    const res = await fetch(`http://127.0.0.1:${project.port}/ci/build-status`, {
      method: 'POST',
      headers: { 'X-Sender': 'dev' },
      body: 'build passed',
    })
    expect(res.ok).toBe(true)

    await waitFor(() => received.length > before, 5000, 'non-root path notification')

    const event = received[before]
    expect(event?.content).toBe('build passed')
    expect(event?.meta?.path).toBe('/ci/build-status')
    expect(event?.meta?.method).toBe('POST')
    expect(event?.meta?.origin).toBe('webhook')
    expect(event?.meta?.sender).toBe('dev')
  })

  test('a query string on the path is stripped from meta.path (url.pathname semantics)', async () => {
    const before = received.length
    const res = await fetch(`http://127.0.0.1:${project.port}/ci/build-status?run=1234`, {
      method: 'POST',
      headers: { 'X-Sender': 'dev' },
      body: 'build passed with run id',
    })
    expect(res.ok).toBe(true)

    await waitFor(() => received.length > before, 5000, 'query-string path notification')

    const event = received[before]
    expect(event?.content).toBe('build passed with run id')
    expect(event?.meta?.path).toBe('/ci/build-status')
    expect(event?.meta?.path).not.toContain('?')
    expect(event?.meta?.path).not.toContain('run=1234')
    expect(event?.meta?.method).toBe('POST')
    expect(event?.meta?.origin).toBe('webhook')
    expect(event?.meta?.sender).toBe('dev')
  })

  test('a different HTTP method (PUT) against the same path reflects that method', async () => {
    const before = received.length
    const res = await fetch(`http://127.0.0.1:${project.port}/ci/build-status`, {
      method: 'PUT',
      headers: { 'X-Sender': 'dev' },
      body: 'build status updated via PUT',
    })
    expect(res.ok).toBe(true)

    await waitFor(() => received.length > before, 5000, 'PUT notification')

    const event = received[before]
    expect(event?.content).toBe('build status updated via PUT')
    expect(event?.meta?.path).toBe('/ci/build-status')
    expect(event?.meta?.method).toBe('PUT')
    expect(event?.meta?.origin).toBe('webhook')
    expect(event?.meta?.sender).toBe('dev')
  })
})
