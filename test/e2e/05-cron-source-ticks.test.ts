/*
 * Pins the cron builtin end to end: ungated, it emits `cron tick at <ISO
 * timestamp>` with no meta of its own, so the notification's meta is exactly
 * `origin: 'cron'`.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { type ProjectSession, projectFixture, type ReceivedEvent, seed, waitFor } from './helpers.ts'

const CRON_INTERVAL_MS = 300

const project = projectFixture({
  sources: { 'webhook.ts': seed('webhook'), 'cron.ts': seed('cron'), 'filedrop.ts': seed('filedrop') },
  env: { CRON_INTERVAL_MS: String(CRON_INTERVAL_MS) },
})

let session: ProjectSession
let received: ReceivedEvent[]

beforeAll(async () => {
  session = project.session()
  received = session.notifications
  await session.connect()
  await session.ready()
}, 20_000)

describe('cron source', () => {
  test('emits periodic tick notifications with cron origin metadata', async () => {
    /*
     * 300ms interval => ~16 ticks within 5s; 3 is a very safe floor proving
     * real periodic emission rather than a fluke single delivery.
     */
    await waitFor(() => received.length >= 3, 5000, 'at least 3 cron tick notifications')

    const tickTimestampPattern = /^cron tick at (.+)$/

    const timestamps = received.slice(0, 3).map(event => {
      expect(event.meta?.origin).toBe('cron')
      expect(event.content).toMatch(/^cron tick at .+/)

      const match = event.content.match(tickTimestampPattern)
      expect(match).not.toBeNull()
      const isoString = match?.[1] ?? ''
      const parsed = new Date(isoString).getTime()
      expect(Number.isNaN(parsed)).toBe(false)
      return parsed
    })

    /*
     * Prove these are real, distinct periodic emissions, not the same event
     * delivered multiple times: consecutive timestamps must strictly increase.
     */
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1] as number)
    }
  }, 8000)
})
