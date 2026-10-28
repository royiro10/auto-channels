/*
 * Pins per-event isolation in one burst: a source emitting an
 * invalid event among valid ones in one synchronous loop loses only the
 * invalid one; its siblings all arrive.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { type ProjectSession, projectFixture, type ReceivedEvent, seed, waitFor } from './helpers.ts'

const project = projectFixture({
  sources: { 'webhook.ts': seed('webhook'), 'cron.ts': seed('cron'), 'filedrop.ts': seed('filedrop') },
})
const TEMP_SOURCE = 'e2e_20_temp.ts'

let session: ProjectSession
let received: ReceivedEvent[]

beforeAll(async () => {
  session = project.session()
  received = session.notifications
  await session.connect()
  await session.ready({ health: true })
}, 20_000)

describe('a malformed frame in a batch does not cost its valid siblings', () => {
  test('good events on either side of a bad one still arrive', async () => {
    project.writeSource(
      TEMP_SOURCE,
      `
import type { Source } from 'auto-channels/shared/source.ts'
const fixture: Source = {
  name: 'e2e-20-temp',
  description: 'e2e fixture',
  start(ctx) {
    // Synchronous burst: these three emit()s are very likely to coalesce
    // into a single socket write/read, exercising the batching scenario --
    // but the assertions in this test hold either way, since per-line
    // isolation in decodeFrames() works regardless of how the writes land.
    ctx.emit({ content: 'e2e-20 good before' })
    ctx.emit({ content: 123 as unknown as string }) // bypasses TS at the call site, not a syntax error
    ctx.emit({ content: 'e2e-20 good after' })
  },
}
export default fixture
`,
    )

    try {
      await waitFor(
        () => received.some(event => event.content === 'e2e-20 good before'),
        5000,
        'the event before the bad one',
      )
      await waitFor(
        () => received.some(event => event.content === 'e2e-20 good after'),
        5000,
        'the event after the bad one',
      )

      // The whole daemon/adapter pipeline must still be healthy afterward too.
      const health = await fetch(`http://127.0.0.1:${project.port}/health`)
      expect(health.status).toBe(200)
    } finally {
      project.removeSource(TEMP_SOURCE)
    }
  }, 10_000)
})
