/*
 * Pins that renaming a source file to a leading underscore disables it: its
 * stop() runs, it stops emitting, and nothing replaces it.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { type ProjectSession, projectFixture, type ReceivedEvent, seed, waitFor, waitForSource } from './helpers.ts'

const project = projectFixture({
  sources: { 'webhook.ts': seed('webhook'), 'cron.ts': seed('cron'), 'filedrop.ts': seed('filedrop') },
})
const TICK_CONTENT = 'e2e-18 fixture tick'

let session: ProjectSession
let received: ReceivedEvent[]

function tickCount(): number {
  return received.filter(event => event.content === TICK_CONTENT).length
}

beforeAll(async () => {
  session = project.session()
  received = session.notifications
  await session.connect()
  await session.ready({ health: true })
}, 20_000)

describe('renaming a source with a leading underscore disables it', () => {
  test('the source stops emitting after being renamed, without being deleted', async () => {
    project.writeSource(
      'e2e_18_temp.ts',
      `
import type { Source } from 'auto-channels/shared/source.ts'
const fixture: Source = {
  name: 'e2e-18-temp',
  description: 'e2e fixture',
  start(ctx) {
    const id = setInterval(() => ctx.emit({ content: '${TICK_CONTENT}' }), 200)
    return () => clearInterval(id)
  },
}
export default fixture
`,
    )

    try {
      // (1) Confirm it loaded and is actually running.
      await waitFor(() => tickCount() >= 2, 5000, 'at least 2 fixture ticks before disabling')

      /*
       * (2) Disable it via rename, per the documented convention -- the file
       * still exists on disk the whole time, just under a different name.
       */
      const disabled = join(project.paths.sourcesDir, '_e2e_18_temp.ts')
      renameSync(join(project.paths.sourcesDir, 'e2e_18_temp.ts'), disabled)
      expect(existsSync(disabled)).toBe(true)

      // The unload itself, not a guessed delay — the count is final once it's gone (see waitForSource).
      await waitForSource(session.client, 'e2e-18-temp', false)
      const countAtRename = tickCount()

      /*
       * (3) No further ticks -- proves start() was truly torn down (stop()
       * called, interval cleared), not just that the old path is gone.
       */
      await new Promise(resolve => setTimeout(resolve, 1000))
      expect(tickCount()).toBe(countAtRename)

      // (4) The daemon itself is unaffected -- still healthy.
      const health = await fetch(`http://127.0.0.1:${project.port}/health`)
      expect(health.status).toBe(200)
    } finally {
      for (const filename of ['e2e_18_temp.ts', '_e2e_18_temp.ts']) project.removeSource(filename)
    }
  }, 10_000)
})
