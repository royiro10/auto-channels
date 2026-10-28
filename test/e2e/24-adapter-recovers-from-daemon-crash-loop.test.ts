/*
 * Pins recovery from a crash loop: with every new daemon killed as
 * fast as it appears for a few seconds, the adapter keeps spawning on every
 * failed attempt and the pipeline recovers once the killing stops.
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
  await session.ready()
}, 20_000)

describe('adapter recovers even when the daemon crashes repeatedly before ever reconnecting', () => {
  test('killing every daemon PID as fast as it reappears still eventually recovers a working pipeline', async () => {
    const before = session.connectCount
    const seenPids = new Set<number>()
    let killCount = 0
    const deadline = Date.now() + 4000

    /*
     * As fast as the event loop allows: whenever a (possibly brand new) PID
     * shows up, kill it immediately -- simulating a daemon that crashes
     * again right after being (re)spawned, well before the adapter's own
     * reconnect backoff would next try to connect to it.
     */
    while (Date.now() < deadline) {
      const pid = project.daemonPid()
      if (pid !== undefined && !seenPids.has(pid)) {
        seenPids.add(pid)
        try {
          process.kill(pid, 'SIGKILL')
          killCount++
        } catch {}
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    /*
     * A single-spawn-per-outage bug would show up here as killCount === 1
     * (or occasionally 2, if timing happened to let one respawn attempt
     * through) -- the fix must let several distinct PIDs get spawned and
     * killed across this window.
     */
    expect(killCount).toBeGreaterThan(1)

    /*
     * Now stop interfering and confirm the pipeline actually recovers -- not
     * just that *a* process exists, but that it's the real daemon, connected
     * to by this adapter, correctly serving webhook traffic end to end.
     */
    await waitFor(
      async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${project.port}/health`)
          return res.ok
        } catch {
          return false
        }
      },
      15_000,
      'webhook health check to succeed again after the crash loop stops',
    )
    await waitFor(() => session.connectCount > before, 15_000, 'a later adapter-connected marker after the crash loop')

    await fetch(`http://127.0.0.1:${project.port}/`, {
      method: 'POST',
      headers: { 'X-Sender': 'dev' },
      body: 'post-crash-loop-recovery message',
    })
    await waitFor(
      () => received.some(event => event.content === 'post-crash-loop-recovery message'),
      5000,
      'a real event to arrive after recovering from the crash loop',
    )
  }, 30_000)
})
