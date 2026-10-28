/*
 * Pins that one dead session cannot break delivery to others: with one
 * adapter SIGKILLed, the next event still reaches the surviving session on
 * the same daemon.
 */
import { describe, expect, test } from 'bun:test'
import { projectFixture, seed, waitFor } from './helpers.ts'

const project = projectFixture({
  sources: { 'webhook.ts': seed('webhook'), 'cron.ts': seed('cron'), 'filedrop.ts': seed('filedrop') },
})

describe('one session dying does not affect the daemon or other sessions', () => {
  test('killing one adapter mid-flight still lets a surviving session receive the next broadcast', async () => {
    const sessionA = project.session({ name: 'session-A' })
    const sessionB = project.session({ name: 'session-B' })
    await Promise.all([sessionA.connect(), sessionB.connect()])

    await sessionA.ready({ health: true })
    await sessionB.ready()

    // Confirm both work before killing anything.
    await fetch(`http://127.0.0.1:${project.port}/`, {
      method: 'POST',
      headers: { 'X-Sender': 'dev' },
      body: 'before the kill',
    })
    await waitFor(
      () => sessionA.received.length >= 1 && sessionB.received.length >= 1,
      5000,
      'both sessions to receive the first event',
    )

    /*
     * Hard-kill session A's adapter process -- no graceful client.close(), no
     * chance for any cleanup handler to run. The daemon should only see the
     * resulting socket close (via the OS tearing down A's side of the pipe)
     * and drop A from its client set, same as any other disconnect.
     */
    const pid = sessionA.transport.pid
    expect(pid).not.toBeNull()
    process.kill(pid as number, 'SIGKILL')

    await waitFor(
      async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${project.port}/health`)
          return res.ok
        } catch {
          return false
        }
      },
      5000,
      'daemon/webhook to still be alive after the kill',
    )

    await fetch(`http://127.0.0.1:${project.port}/`, {
      method: 'POST',
      headers: { 'X-Sender': 'dev' },
      body: 'after the kill',
    })

    await waitFor(
      () => sessionB.received.includes('after the kill'),
      5000,
      'surviving session to receive the second event',
    )
    expect(sessionB.received).toEqual(['before the kill', 'after the kill'])
  }, 20_000)
})
