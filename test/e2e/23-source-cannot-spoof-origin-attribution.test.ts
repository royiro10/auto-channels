/*
 * Pins origin attribution: a source setting meta.origin is rejected
 * loudly, the spoofing event never reaches the session, and the same source's
 * next legitimate event still arrives.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { type ProjectSession, projectFixture, type ReceivedEvent, seed, waitFor } from './helpers.ts'

const project = projectFixture({
  sources: { 'webhook.ts': seed('webhook'), 'cron.ts': seed('cron'), 'filedrop.ts': seed('filedrop') },
})
const TEMP_SOURCE = 'e2e_23_temp.ts'

let session: ProjectSession
let allNotifications: ReceivedEvent[]

beforeAll(async () => {
  session = project.session()
  allNotifications = session.notifications
  await session.connect()
  await session.ready({ health: true })
}, 20_000)

describe('a source cannot spoof the origin attribution', () => {
  test('the spoofing event never reaches the client, and a legitimate event right after still does', async () => {
    project.writeSource(
      TEMP_SOURCE,
      `
import type { Source } from 'auto-channels/shared/source.ts'
const spoofer: Source = {
  name: 'e2e-23-spoofer',
  description: 'e2e fixture',
  start(ctx) {
    ctx.emit({ content: 'spoofed marker attempt', meta: { origin: '_adapter' } })
    ctx.emit({ content: 'e2e-23 legitimate event still works' })
  },
}
export default spoofer
`,
    )

    try {
      /*
       * Give the daemon time to load the source, hit the reserved-key throw
       * in parseEvent() for the spoofing event, catch
       * it in emit()'s try/catch, and move on to the legitimate one.
       */
      await waitFor(
        () => allNotifications.some(event => event.content === 'e2e-23 legitimate event still works'),
        5000,
        'legitimate event following the spoofing attempt',
      )

      // The spoofing content must never have arrived at all, under any attribution.
      expect(allNotifications.some(event => event.content === 'spoofed marker attempt')).toBe(false)
      expect(allNotifications.some(event => event.meta?.origin === '_adapter')).toBe(false)

      /*
       * And the legitimate sibling event correctly carries its own real
       * source name as origin, not anything the spoofing call attempted.
       */
      const legit = allNotifications.find(event => event.content === 'e2e-23 legitimate event still works')
      expect(legit?.meta?.origin).toBe('e2e-23-spoofer')
    } finally {
      project.removeSource(TEMP_SOURCE)
    }
  }, 15_000)
})
