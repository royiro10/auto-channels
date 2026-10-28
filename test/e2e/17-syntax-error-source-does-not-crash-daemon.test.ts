/*
 * Pins that a source file with a syntax error (an agent mid-edit) fails only
 * itself: the daemon and its other sources keep serving, and fixing the file
 * loads it normally on the next reload.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { type ProjectSession, projectFixture, type ReceivedEvent, seed, waitFor } from './helpers.ts'

const project = projectFixture({
  sources: { 'webhook.ts': seed('webhook'), 'cron.ts': seed('cron'), 'filedrop.ts': seed('filedrop') },
})
const TEMP_SOURCE = 'e2e_17_temp.ts'

let session: ProjectSession
let received: ReceivedEvent[]

beforeAll(async () => {
  session = project.session()
  received = session.notifications
  await session.connect()
  await session.ready({ health: true })
}, 20_000)

describe('a source file with a syntax error cannot crash the daemon', () => {
  test('daemon and sibling sources stay healthy through a broken save, and recover once fixed', async () => {
    // Missing comma after `name: 'e2e-17-broken'` -- a plausible save mid-edit.
    project.writeSource(
      TEMP_SOURCE,
      `
import type { Source } from 'auto-channels/shared/source.ts'
const broken: Source = {
  name: 'e2e-17-broken'
  start(ctx) { ctx.emit({ content: 'should never load' }) }
}
export default broken
`,
    )
    // Give sourceLoader's 150ms debounce plus the (failing) build attempt time to run.
    await new Promise(resolve => setTimeout(resolve, 1000))

    /*
     * The daemon must still be alive and healthy -- not just "the process
     * exists" but genuinely still serving requests, including from a
     * completely different source (webhook.ts) sharing the same process.
     */
    const health = await fetch(`http://127.0.0.1:${project.port}/health`)
    expect(health.status).toBe(200)

    const webhookRes = await fetch(`http://127.0.0.1:${project.port}/`, {
      method: 'POST',
      headers: { 'X-Sender': 'dev' },
      body: 'webhook still works despite a broken sibling source',
    })
    expect(webhookRes.status).toBe(200)
    await waitFor(
      () => received.some(event => event.content === 'webhook still works despite a broken sibling source'),
      5000,
      'webhook event while a sibling source has a syntax error',
    )

    /*
     * The broken source itself must never have loaded -- its content string
     * should never appear, since the module never finished building.
     */
    expect(received.some(event => event.content === 'should never load')).toBe(false)

    // Recovery: fixing the syntax lets it load and work normally on the next reload.
    project.writeSource(
      TEMP_SOURCE,
      `
import type { Source } from 'auto-channels/shared/source.ts'
const fixed: Source = {
  name: 'e2e-17-fixed',
  description: 'e2e fixture',
  start(ctx) { ctx.emit({ content: 'e2e-17 fixed and loaded' }) },
}
export default fixed
`,
    )
    await waitFor(
      () => received.some(event => event.content === 'e2e-17 fixed and loaded'),
      5000,
      'the source to load successfully once its syntax is fixed',
    )
  }, 15_000)
})
