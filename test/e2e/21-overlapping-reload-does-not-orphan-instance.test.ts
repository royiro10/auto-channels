/*
 * Pins that overlapping reloads never orphan an instance: a file
 * edited again while its slow async start() is in flight ends with exactly
 * one running instance, the latest, and a deletion mid-load leaves none.
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ProjectSession, projectFixture, type ReceivedEvent, seed, waitFor, waitForSource } from './helpers.ts'

const project = projectFixture({
  sources: { 'webhook.ts': seed('webhook'), 'cron.ts': seed('cron'), 'filedrop.ts': seed('filedrop') },
})
const TEMP_SOURCE = 'e2e_21_temp.ts'
const PROBE_SOURCE = 'e2e_21_probe.ts'
// Under the fixture root, which exists only once beforeAll has run.
const started = () => join(project.root, 'e2e-21-started')
const gate = () => join(project.root, 'e2e-21-gate')

let session: ProjectSession
let received: ReceivedEvent[]

/*
 * A source whose start() marks that it is running, then blocks until the test
 * opens the gate: the race "edited or deleted while start() is in flight" is
 * set up by signals, never by betting that a reload lands inside a delay.
 */
function gatedFixture(tickContent: string): string {
  return `
import { existsSync, writeFileSync } from 'node:fs'
import type { Source } from 'auto-channels/shared/source.ts'
const slow: Source = {
  name: '${tickContent}',
  description: 'e2e fixture',
  async start(ctx) {
    writeFileSync(${JSON.stringify(started())}, '')
    while (!existsSync(${JSON.stringify(gate())})) await new Promise(resolve => setTimeout(resolve, 20))
    const id = setInterval(() => ctx.emit({ content: '${tickContent}' }), 150)
    return () => clearInterval(id)
  },
}
export default slow
`
}

function tickingFixture(tickContent: string): string {
  return `
import type { Source } from 'auto-channels/shared/source.ts'
const ticking: Source = {
  name: '${tickContent}',
  description: 'e2e fixture',
  start(ctx) {
    const id = setInterval(() => ctx.emit({ content: '${tickContent}' }), 150)
    return () => clearInterval(id)
  },
}
export default ticking
`
}

/** Write a gated source and resolve once its start() is running. */
async function writeGatedAndWaitForStart(tickContent: string): Promise<void> {
  rmSync(started(), { force: true })
  rmSync(gate(), { force: true })
  project.writeSource(TEMP_SOURCE, gatedFixture(tickContent))
  await waitFor(() => existsSync(started()), 10_000, `${tickContent}'s start() to begin`)
}

const count = (content: string) => received.filter(event => event.content === content).length

beforeAll(async () => {
  session = project.session()
  received = session.notifications
  await session.connect()
  await session.ready({ health: true })
}, 20_000)

describe('editing a source again while its slow start() is still in flight does not orphan an instance', () => {
  test('only the newer version keeps ticking; the superseded one stops for good', async () => {
    try {
      await writeGatedAndWaitForStart('e2e-21-v1-tick')
      project.writeSource(TEMP_SOURCE, tickingFixture('e2e-21-v2-tick'))
      // v2 registered: its load replaced v1's slot while v1's start() was still blocked.
      await waitForSource(session.client, 'e2e-21-v2-tick', true)
      writeFileSync(gate(), '')
      await waitFor(() => count('e2e-21-v2-tick') > 0, 5000, 'v2 to start ticking')

      /*
       * v1's start() now resolves into a superseded slot. An orphan would poll
       * the gate within 20ms and tick every 150ms: 1s would show several ticks.
       */
      await new Promise(resolve => setTimeout(resolve, 1000))
      expect(count('e2e-21-v1-tick')).toBe(0)

      /*
       * And v2 must still be a *single* live instance: 3000ms / 150ms ≈ 20 ticks
       * from one instance, ≈ 40 from two. The window is long on purpose: a short
       * one can't tell a second instance from one delivery stall followed by a
       * catch-up burst on a loaded machine.
       */
      const countAtCheckpoint = count('e2e-21-v2-tick')
      await new Promise(resolve => setTimeout(resolve, 3000))
      expect(count('e2e-21-v2-tick') - countAtCheckpoint).toBeLessThanOrEqual(30)
    } finally {
      writeFileSync(gate(), '')
      project.removeSource(TEMP_SOURCE)
    }
  }, 20_000)

  test('deleting the file while start() is still in flight also stops the instance for good, not just edits', async () => {
    try {
      await writeGatedAndWaitForStart('e2e-21-deleted-tick')
      project.removeSource(TEMP_SOURCE)
      /*
       * No log or registry change marks a never-registered file's removal. A probe
       * written after it does: the watcher reports the deletion no later than the
       * probe, and the deletion's retire is synchronous while the probe still has
       * to import and start before it is listed.
       */
      project.writeSource(PROBE_SOURCE, tickingFixture('e2e-21-probe-tick'))
      await waitForSource(session.client, 'e2e-21-probe-tick', true)
      writeFileSync(gate(), '')
      await waitFor(() => count('e2e-21-probe-tick') > 0, 5000, 'the probe to tick')

      // As above: an orphan would tick several times in this window.
      await new Promise(resolve => setTimeout(resolve, 1000))
      expect(count('e2e-21-deleted-tick')).toBe(0)
    } finally {
      writeFileSync(gate(), '')
      project.removeSource(PROBE_SOURCE)
    }
  }, 20_000)
})
