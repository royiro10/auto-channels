/*
 * Pins that a graceful daemon shutdown runs every source's stop(),
 * and that one throwing stop() neither skips the others nor aborts the
 * shutdown.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { projectFixture, seed, waitFor, waitForSource } from './helpers.ts'

const project = projectFixture({
  sources: { 'webhook.ts': seed('webhook'), 'cron.ts': seed('cron'), 'filedrop.ts': seed('filedrop') },
})

let client: Client

beforeAll(async () => {
  const session = project.session()
  client = session.client
  await session.connect()
  await session.ready({ health: true })
}, 20_000)

describe('a graceful daemon shutdown stops every loaded source, not just hot-reloaded ones', () => {
  test("sending SIGTERM to the daemon calls the source's stop() before the process exits", async () => {
    const STOP_MARKER = join(project.root, 'e2e-25-stop-marker.txt')
    project.writeSource(
      'e2e_25_temp.ts',
      `
import { writeFileSync } from 'node:fs'
import type { Source } from 'auto-channels/shared/source.ts'
const src: Source = {
  name: 'e2e-25-shutdown-check',
  description: 'e2e fixture',
  start(ctx) {
    return () => writeFileSync(${JSON.stringify(STOP_MARKER)}, 'stop() was called')
  },
}
export default src
`,
    )

    // Shut down only once the fixture is really loaded — its stop() is what's under test.
    await waitForSource(client, 'e2e-25-shutdown-check', true)

    const pid = project.daemonPid()
    expect(pid).toBeDefined()
    process.kill(pid as number, 'SIGTERM')

    await waitFor(() => existsSync(STOP_MARKER), 5000, "the source's stop() to run during graceful shutdown")
    expect(readFileSync(STOP_MARKER, 'utf8')).toBe('stop() was called')

    /*
     * The daemon process itself must actually be gone, not just the marker
     * written by some other means.
     */
    await waitFor(
      () => {
        try {
          process.kill(pid as number, 0)
          return false
        } catch {
          return true
        }
      },
      5000,
      'the daemon process to actually exit',
    )
  }, 15_000)

  test("a throwing stop() doesn't stop other sources' stop() from running or crash the shutdown", async () => {
    /*
     * A source's stop() is just as user-authored as its start(), and just as
     * able to misbehave. Reproduced directly before fixing it: an unguarded
     * stop() call in close() (then stopAll()) let one throw abort every other tracked
     * source's stop() in the same pass and crash the daemon before it ever
     * reached the rest of its shutdown sequence -- leaving the socket file
     * and lock directory behind afterward instead of a clean exit.
     * The previous test killed the daemon; the adapter's own crash recovery
     * (see test/e2e/24-...) will have already respawned and reconnected to a
     * fresh one, but make sure that's actually settled before proceeding.
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
      10_000,
      'daemon respawned by the adapter after the previous test to be ready',
    )

    const THROWING_SOURCE = 'e2e_25_throwing.ts'
    const OTHER_SOURCE = 'e2e_25_zzz_other.ts'
    const OTHER_MARKER = join(project.root, 'e2e-25-other-marker.txt')

    project.writeSource(
      THROWING_SOURCE,
      `
import type { Source } from 'auto-channels/shared/source.ts'
const src: Source = {
  name: 'e2e-25-throwing',
  description: 'e2e fixture',
  start(ctx) {
    return () => { throw new Error('deliberately throws') }
  },
}
export default src
`,
    )
    project.writeSource(
      OTHER_SOURCE,
      `
import { writeFileSync } from 'node:fs'
import type { Source } from 'auto-channels/shared/source.ts'
const src: Source = {
  name: 'e2e-25-zzz-other',
  description: 'e2e fixture',
  start(ctx) {
    return () => writeFileSync(${JSON.stringify(OTHER_MARKER)}, 'ran despite the other source throwing')
  },
}
export default src
`,
    )

    try {
      /*
       * Both must be really loaded: a fixed delay here once let SIGTERM land
       * before the second fixture's hot-load, so its stop() "never ran".
       */
      await waitForSource(client, 'e2e-25-throwing', true)
      await waitForSource(client, 'e2e-25-zzz-other', true)

      const pid = project.daemonPid()
      expect(pid).toBeDefined()
      process.kill(pid as number, 'SIGTERM')

      await waitFor(() => existsSync(OTHER_MARKER), 5000, "the other source's stop() to still run")
      expect(readFileSync(OTHER_MARKER, 'utf8')).toBe('ran despite the other source throwing')

      await waitFor(
        () => {
          try {
            process.kill(pid as number, 0)
            return false
          } catch {
            return true
          }
        },
        5000,
        'the daemon to still exit cleanly despite the throw',
      )

      /*
       * A crash via uncaught exception (instead of reaching process.exit(0)
       * after the rest of the shutdown sequence) would skip removing these.
       */
      expect(existsSync(project.paths.socketPath)).toBe(false)
      expect(existsSync(project.paths.pidPath)).toBe(false)
    } finally {
      for (const filename of [THROWING_SOURCE, OTHER_SOURCE]) project.removeSource(filename)
    }
  }, 15_000)
})
