/*
 * Pins crash recovery: a daemon SIGKILLed under a connected adapter is
 * respawned and reconnected, and the recovered pipeline delivers again.
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

describe('adapter reconnects after daemon crash', () => {
  test('exactly one connected marker has arrived so far', () => {
    expect(session.connectCount).toBe(1)
  })

  test('the pipeline works before anything is broken', async () => {
    await fetch(`http://127.0.0.1:${project.port}/`, {
      method: 'POST',
      headers: { 'X-Sender': 'dev' },
      body: 'pre-crash message',
    })
    await waitFor(() => received.length >= 1, 5000, 'first notification to arrive')

    expect(received[0]?.content).toBe('pre-crash message')
    expect(received[0]?.meta?.origin).toBe('webhook')
    expect(received[0]?.meta?.sender).toBe('dev')
  })

  test('killing the daemon triggers a respawn and reconnect', async () => {
    const originalPid = project.daemonPid()
    expect(originalPid).toBeDefined()
    const before = session.connectCount

    /*
     * Simulate a real crash, not a graceful shutdown: SIGKILL bypasses the
     * daemon's SIGTERM/SIGINT handlers entirely (no socket/pidfile cleanup),
     * which is exactly the scenario the adapter's 'error'/'close' handlers
     * (not a graceful-exit code path) need to detect.
     */
    process.kill(originalPid as number, 'SIGKILL')

    /*
     * Give the adapter's reconnect backoff (starts ~1s) and a fresh daemon
     * cold-start (spawn + listen) time to complete.
     */
    await waitFor(() => session.connectCount > before, 15_000, 'second adapter-connected marker after crash')

    /*
     * A new daemon process must actually be listening: the PID file gets
     * overwritten only once the new daemon's server.listen callback fires.
     */
    await waitFor(
      () => (project.daemonPid() ?? originalPid) !== originalPid,
      10_000,
      'PID file updated with new daemon pid',
    )
  }, 20_000)

  test('the recovered pipeline is fully functional again', async () => {
    await fetch(`http://127.0.0.1:${project.port}/`, {
      method: 'POST',
      headers: { 'X-Sender': 'dev' },
      body: 'post-recovery message',
    })
    await waitFor(
      () => received.some(event => event.content === 'post-recovery message'),
      5000,
      'post-recovery notification',
    )

    const event = received.find(e => e.content === 'post-recovery message')
    expect(event?.meta?.origin).toBe('webhook')
    expect(event?.meta?.sender).toBe('dev')
  })
})
