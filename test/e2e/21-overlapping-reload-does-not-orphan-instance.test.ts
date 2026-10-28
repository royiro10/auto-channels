/*
 * Pins that overlapping reloads never orphan an instance: a file
 * edited again while its slow async start() is in flight ends with exactly
 * one running instance, the latest, and a deletion mid-load leaves none.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { type ProjectSession, projectFixture, type ReceivedEvent, seed, waitFor } from './helpers.ts'

const project = projectFixture({
  sources: { 'webhook.ts': seed('webhook'), 'cron.ts': seed('cron'), 'filedrop.ts': seed('filedrop') },
})
const TEMP_SOURCE = 'e2e_21_temp.ts'

let session: ProjectSession
let received: ReceivedEvent[]

function slowStartFixture(tickContent: string): string {
  return `
import type { Source } from 'auto-channels/shared/source.ts'
const slow: Source = {
  name: '${tickContent}',
  description: 'e2e fixture',
  async start(ctx) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const id = setInterval(() => ctx.emit({ content: '${tickContent}' }), 150)
    return () => clearInterval(id)
  },
}
export default slow
`
}

beforeAll(async () => {
  session = project.session()
  received = session.notifications
  await session.connect()
  await session.ready({ health: true })
}, 20_000)

describe('editing a source again while its slow start() is still in flight does not orphan an instance', () => {
  test('only the newer version keeps ticking; the superseded one stops for good', async () => {
    project.writeSource(TEMP_SOURCE, slowStartFixture('e2e-21-v1-tick'))
    // Edit again well before the 500ms start() delay elapses -- this is the race.
    await new Promise(resolve => setTimeout(resolve, 150))
    project.writeSource(TEMP_SOURCE, slowStartFixture('e2e-21-v2-tick'))

    try {
      // v2 should eventually start ticking.
      await waitFor(() => received.some(event => event.content === 'e2e-21-v2-tick'), 5000, 'v2 to start ticking')

      /*
       * Give v1 every chance to have also started ticking if the bug were
       * present (its own 500ms delay plus a couple of 150ms tick intervals).
       */
      await new Promise(resolve => setTimeout(resolve, 1000))

      const v1Ticks = received.filter(event => event.content === 'e2e-21-v1-tick').length
      const v2TicksSoFar = received.filter(event => event.content === 'e2e-21-v2-tick').length
      expect(v1Ticks).toBe(0)
      expect(v2TicksSoFar).toBeGreaterThan(0)

      /*
       * And v2 must still be a *single* live instance, not two overlapping
       * ones of its own from some other interleaving -- ticks keep flowing at
       * roughly one interval's pace, not two instances' worth.
       */
      const countAtCheckpoint = v2TicksSoFar
      await new Promise(resolve => setTimeout(resolve, 3000))
      const countAfterWindow = received.filter(event => event.content === 'e2e-21-v2-tick').length
      /*
       * 3000ms / 150ms ≈ 20 ticks from a single instance; a duplicate would
       * show ≈ 40. The window is long on purpose: a short one (it was 500ms,
       * bound 5) can't tell a second instance from one delivery stall
       * followed by a catch-up burst on a loaded machine.
       */
      expect(countAfterWindow - countAtCheckpoint).toBeLessThanOrEqual(30)
    } finally {
      project.removeSource(TEMP_SOURCE)
    }
  }, 15_000)

  test('deleting the file while start() is still in flight also stops the instance for good, not just edits', async () => {
    project.writeSource(TEMP_SOURCE, slowStartFixture('e2e-21-deleted-tick'))
    /*
     * Delete it well before the 500ms start() delay elapses -- same race,
     * different trigger: the generation bump has to happen regardless of
     * whether the reload that caused it was an edit or a removal.
     */
    await new Promise(resolve => setTimeout(resolve, 150))
    project.removeSource(TEMP_SOURCE)

    /*
     * Give the slow start() every chance to finish and start ticking into a
     * file that no longer exists.
     */
    await new Promise(resolve => setTimeout(resolve, 2000))

    expect(received.some(event => event.content === 'e2e-21-deleted-tick')).toBe(false)
  }, 15_000)
})
