/*
 * Pins crash isolation for an invalid event: a hyphenated meta key is
 * dropped and logged, the same source's next valid event still arrives, and
 * the webhook keeps working.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { type ProjectSession, projectFixture, type ReceivedEvent, seed, waitFor } from './helpers.ts'

const project = projectFixture({
  sources: { 'webhook.ts': seed('webhook'), 'cron.ts': seed('cron'), 'filedrop.ts': seed('filedrop') },
})
const TEMP_SOURCE = 'e2e_13_temp.ts'

let session: ProjectSession
let received: ReceivedEvent[]

beforeAll(async () => {
  session = project.session()
  received = session.notifications
  await session.connect()
  await session.ready({ health: true })
}, 20_000)

describe('a misbehaving source with an invalid meta key cannot crash the daemon', () => {
  test('the bad event is dropped, the following good event and the rest of the daemon still work', async () => {
    project.writeSource(
      TEMP_SOURCE,
      `
import type { Source } from 'auto-channels/shared/source.ts'
const badSource: Source = {
  name: 'e2e-13-bad',
  description: 'e2e fixture',
  start(ctx) {
    ctx.emit({ content: 'this should never arrive', meta: { 'bad-key': 'x' } })
    ctx.emit({ content: 'e2e-13 good event still works' })
  },
}
export default badSource
`,
    )

    try {
      /*
       * Give the daemon plenty of time to load the source, hit the throw in
       * parseEvent() for the bad event, catch it in
       * emit()'s try/catch, and move on. If the fix regressed and the
       * throw were uncaught, the daemon process would die here and neither
       * event nor the following webhook check would ever succeed.
       */
      await new Promise(resolve => setTimeout(resolve, 2000))

      expect(received.some(event => event.content === 'this should never arrive')).toBe(false)

      /*
       * The valid event emitted right after the bad one from the same
       * source's start() must still have gone through — proving the daemon
       * kept running and didn't drop everything from this source.
       */
      await waitFor(
        () => received.some(event => event.content === 'e2e-13 good event still works'),
        5000,
        'good event following the bad one',
      )

      /*
       * Further check that the *whole* daemon process is still healthy, not
       * just this one source: a normal webhook POST on the same running
       * daemon must still work too.
       */
      await fetch(`http://127.0.0.1:${project.port}/`, {
        method: 'POST',
        headers: { 'X-Sender': 'dev' },
        body: 'daemon still alive after bad meta key',
      })
      await waitFor(
        () => received.some(event => event.content === 'daemon still alive after bad meta key'),
        5000,
        'webhook event after misbehaving source',
      )
      const webhookEvent = received.find(event => event.content === 'daemon still alive after bad meta key')
      expect(webhookEvent?.meta?.origin).toBe('webhook')
      expect(webhookEvent?.meta?.sender).toBe('dev')
    } finally {
      project.removeSource(TEMP_SOURCE)
    }
  }, 15_000)
})
