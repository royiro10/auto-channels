/*
 * Pins the delete side of hot-reload: deleting a running source's file calls
 * its stop(), which actually silences it before the source leaves the
 * registry; a stop() returning a rejected promise is logged, not fatal.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { type ProjectSession, projectFixture, type ReceivedEvent, seed, waitFor, waitForSource } from './helpers.ts'

const project = projectFixture({
  sources: { 'webhook.ts': seed('webhook'), 'cron.ts': seed('cron'), 'filedrop.ts': seed('filedrop') },
})
const TEMP_SOURCE = 'e2e_08_temp.ts'
const TICK_CONTENT = 'e2e-08 fixture tick'

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

describe('hot-reload DELETE stops the source', () => {
  test('deleting a source file calls its stop() and it truly stops emitting', async () => {
    project.writeSource(
      TEMP_SOURCE,
      `
import type { Source } from 'auto-channels/shared/source.ts'
const fixture: Source = {
  name: 'e2e-08-temp',
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
      // (1) Confirm it loaded and is actually running: wait for at least 2 ticks.
      await waitFor(() => tickCount() >= 2, 5000, 'at least 2 fixture ticks before deletion')

      /*
       * (2) Delete the fixture file — triggers sourceLoader's reload() path
       * (unload() calling stop(), then a load() that throws ENOENT and is
       * caught/logged, leaving nothing replacing the unloaded source).
       */
      project.removeSource(TEMP_SOURCE)

      /*
       * Wait for the unload itself, not a guessed delay: unload() calls stop()
       * before dropping the registry entry, and the registry frame travels
       * behind every tick on the same ordered socket — so once it's gone
       * here, the tick count is final (see waitForSource).
       */
      await waitForSource(session.client, 'e2e-08-temp', false)
      const countAtDeletion = tickCount()

      // (3) Wait a few tick intervals' worth and assert no new ticks arrive.
      await new Promise(resolve => setTimeout(resolve, 1000))

      expect(tickCount()).toBe(countAtDeletion)
    } finally {
      project.removeSource(TEMP_SOURCE)
    }
  }, 10_000)

  test('a stop() that returns a rejected promise is logged, not fatal', async () => {
    const SIBLING_TICK = 'e2e-08 sibling tick'
    project.writeSource(
      'e2e_08_sibling.ts',
      `import type { Source } from 'auto-channels/shared/source.ts'
const sibling: Source = {
  name: 'e2e-08-sibling',
  description: 'e2e fixture: unrelated ticks that must outlive a rejected async stop()',
  start(ctx) {
    const id = setInterval(() => ctx.emit({ content: '${SIBLING_TICK}' }), 200)
    return () => clearInterval(id)
  },
}
export default sibling
`,
    )
    project.writeSource(
      'e2e_08_async_stop.ts',
      `import type { Source } from 'auto-channels/shared/source.ts'
const asyncStop: Source = {
  name: 'e2e-08-async-stop',
  description: 'e2e fixture: its stop() rejects',
  start() {
    return () => Promise.reject(new Error('async stop boom'))
  },
}
export default asyncStop
`,
    )
    const siblingTicks = () => received.filter(event => event.content === SIBLING_TICK).length
    await waitForSource(session.client, 'e2e-08-async-stop', true)
    await waitFor(() => siblingTicks() >= 1, 5000, 'the sibling ticking')
    const pid = project.daemonPid()
    const log = project.logCursor()

    project.removeSource('e2e_08_async_stop.ts')
    await waitForSource(session.client, 'e2e-08-async-stop', false)
    const before = siblingTicks()
    await waitFor(() => siblingTicks() >= before + 3, 5000, '3 more sibling ticks')
    expect(project.daemonPid()).toBe(pid)
    expect(log.since()).toContain('stop() rejected')
  }, 15_000)
})
