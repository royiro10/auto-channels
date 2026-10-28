/*
 * Pins one daemon per project: two sessions cold-starting at the same instant
 * both connect and both receive a default-subscribed event. That exactly one
 * daemon wins the race is proven by the startup lock's multiprocess tests in
 * test/unit/startupLock.test.ts.
 */
import { describe, expect, test } from 'bun:test'
import { projectFixture, seed, waitFor } from './helpers.ts'

const project = projectFixture({
  sources: { 'webhook.ts': seed('webhook'), 'cron.ts': seed('cron'), 'filedrop.ts': seed('filedrop') },
})

describe('two sessions sharing one daemon', () => {
  test('two sessions starting at the exact same time both connect and both receive an event', async () => {
    // Both sessions start with no daemon running yet -- the cold-start race.
    const sessionA = project.session({ name: 'session-A' })
    const sessionB = project.session({ name: 'session-B' })
    await Promise.all([sessionA.connect(), sessionB.connect()])

    /*
     * Each session's own adapter->daemon socket must be live -- the real
     * readiness signal. Racing ahead without it (as an earlier version of
     * this test did) can post the webhook before both sessions are actually
     * connected, silently dropping the event for whichever adapter hadn't
     * caught up yet.
     */
    await sessionA.ready({ health: true })
    await sessionB.ready()

    await fetch(`http://127.0.0.1:${project.port}/`, {
      method: 'POST',
      headers: { 'X-Sender': 'dev' },
      body: 'broadcast to both sessions',
    })

    await waitFor(
      () => sessionA.received.length >= 1 && sessionB.received.length >= 1,
      5000,
      'both sessions to receive the event',
    )

    expect(sessionA.received).toEqual(['broadcast to both sessions'])
    expect(sessionB.received).toEqual(['broadcast to both sessions'])
  }, 20_000)
})
