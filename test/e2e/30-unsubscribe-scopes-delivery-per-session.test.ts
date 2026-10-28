/*
 * Pins that subscriptions are per session: two sessions share one daemon,
 * session A unsubscribes from the webhook, a POST reaches only B, and A
 * receives again after resubscribing.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { type ProjectSession, projectFixture, seed, waitFor } from './helpers.ts'

const project = projectFixture({
  sources: { 'webhook.ts': seed('webhook'), 'cron.ts': seed('cron'), 'filedrop.ts': seed('filedrop') },
})

async function postWebhook(body: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${project.port}/`, {
    method: 'POST',
    headers: { 'X-Sender': 'dev' },
    body,
  })
  if (res.status !== 200) throw new Error(`webhook POST failed: ${res.status}`)
}

let sessionA: ProjectSession
let sessionB: ProjectSession

beforeAll(async () => {
  sessionA = project.session({ name: 'e2e-30-session-a' })
  await sessionA.connect()
  sessionB = project.session({ name: 'e2e-30-session-b' })
  await sessionB.connect()

  await sessionA.ready({ health: true })
  await sessionB.ready()
}, 20_000)

describe('unsubscribe scopes delivery to the one session that asked', () => {
  test('baseline: both sessions receive the same webhook event', async () => {
    await postWebhook('e2e-30 baseline event')
    await waitFor(
      () => sessionA.received.includes('e2e-30 baseline event') && sessionB.received.includes('e2e-30 baseline event'),
      5000,
      'both sessions to receive the baseline event',
    )
  })

  test("after session A unsubscribes from webhook, B still receives and A doesn't", async () => {
    await sessionA.client.callTool({ name: 'autochannels_unsubscribe', arguments: { source: 'webhook' } })

    await postWebhook('e2e-30 filtered event')
    await waitFor(() => sessionB.received.includes('e2e-30 filtered event'), 5000, 'session B to receive the event')

    /*
     * B receiving it proves the event completed the full pipeline -- so if A
     * were going to (wrongly) receive it too, it would have arrived by now
     * plus a settle window. Not a bare timeout-hoping-nothing-shows-up.
     */
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(sessionA.received.includes('e2e-30 filtered event')).toBe(false)
  })

  test('resubscribing restores delivery to A without affecting B', async () => {
    await sessionA.client.callTool({ name: 'autochannels_subscribe', arguments: { source: 'webhook' } })

    await postWebhook('e2e-30 restored event')
    await waitFor(
      () => sessionA.received.includes('e2e-30 restored event') && sessionB.received.includes('e2e-30 restored event'),
      5000,
      'both sessions to receive the post-resubscribe event',
    )
  })
})
