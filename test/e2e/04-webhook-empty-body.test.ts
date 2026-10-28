/*
 * Verifies the webhook source preserves the exact request body byte-for-byte
 * through the whole pipeline (HTTP -> daemon -> Unix socket JSON framing ->
 * adapter -> MCP notification): an empty body must arrive as content === '',
 * not dropped/crashed/coerced; whitespace-only bodies must not be trimmed;
 * and bodies containing JSON-special characters (quotes, backslashes,
 * newlines) must round-trip verbatim since the wire format is JSON-encoded
 * newline-delimited frames that could mangle those characters if done naively.
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

describe('webhook empty/whitespace/special-character bodies', () => {
  test('a completely empty body arrives as content === "" (not dropped, not coerced)', async () => {
    const res = await fetch(`http://127.0.0.1:${project.port}/`, {
      method: 'POST',
      headers: { 'X-Sender': 'dev' },
      body: '',
    })
    expect(res.ok).toBe(true)

    await waitFor(() => received.length >= 1, 5000, 'first notification to arrive')

    expect(received[0]?.content).toBe('')
    expect(received[0]?.meta?.sender).toBe('dev')
  })

  test('a whitespace-only body is preserved verbatim, not trimmed', async () => {
    const whitespaceBody = '   \n  '
    await fetch(`http://127.0.0.1:${project.port}/`, {
      method: 'POST',
      headers: { 'X-Sender': 'dev' },
      body: whitespaceBody,
    })
    await waitFor(() => received.length >= 2, 5000, 'second notification to arrive')

    expect(received[1]?.content).toBe(whitespaceBody)
  })

  test('a body with a newline and JSON-special characters round-trips byte-for-byte', async () => {
    const trickyBody = 'He said "hi"\nand left\\ok'
    await fetch(`http://127.0.0.1:${project.port}/`, {
      method: 'POST',
      headers: { 'X-Sender': 'dev' },
      body: trickyBody,
    })
    await waitFor(() => received.length >= 3, 5000, 'third notification to arrive')

    expect(received[2]?.content).toBe(trickyBody)
  })
})
