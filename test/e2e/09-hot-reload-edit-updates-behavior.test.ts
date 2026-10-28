/*
 * Pins that editing a source file changes what it emits on the next
 * hot-reload, with no daemon or adapter restart: each load gets a fresh module
 * evaluation, never Bun's cached one.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { type ProjectSession, projectFixture, type ReceivedEvent, seed, waitFor } from './helpers.ts'

const project = projectFixture({
  sources: { 'webhook.ts': seed('webhook'), 'cron.ts': seed('cron'), 'filedrop.ts': seed('filedrop') },
})
const TEMP_SOURCE = 'e2e_09_temp.ts'

let session: ProjectSession
let received: ReceivedEvent[]

function contentsOf(text: string): string[] {
  return received.filter(event => event.content.includes(text)).map(event => event.content)
}

beforeAll(async () => {
  session = project.session()
  received = session.notifications
  await session.connect()
  await session.ready({ health: true })
}, 20_000)

describe('hot-reload: editing a source file changes its behavior with no restart', () => {
  test('version 1 fires once on initial write', async () => {
    project.writeSource(
      TEMP_SOURCE,
      `
import type { Source } from 'auto-channels/shared/source.ts'
const src: Source = { name: 'e2e-09', description: 'e2e fixture', start(ctx) { ctx.emit({ content: 'e2e-09 version 1' }) } }
export default src
`,
    )
    await waitFor(() => contentsOf('e2e-09 version').length >= 1, 5000, 'version 1 event')

    expect(contentsOf('e2e-09 version')).toEqual(['e2e-09 version 1'])
  }, 8000)

  test('overwriting the same file with new code (same name) switches to version 2', async () => {
    project.writeSource(
      TEMP_SOURCE,
      `
import type { Source } from 'auto-channels/shared/source.ts'
const src: Source = { name: 'e2e-09', description: 'e2e fixture', start(ctx) { ctx.emit({ content: 'e2e-09 version 2' }) } }
export default src
`,
    )
    await waitFor(() => contentsOf('e2e-09 version').some(c => c === 'e2e-09 version 2'), 5000, 'version 2 event')

    /*
     * Both versions were seen, in order — proves the edit actually took effect
     * (the reload picked up new content) rather than the daemon silently keeping
     * the old cached module running forever.
     */
    expect(contentsOf('e2e-09 version')).toEqual(['e2e-09 version 1', 'e2e-09 version 2'])
  }, 8000)

  test('overwriting a third time with an interval-based version fully replaces version 2', async () => {
    project.writeSource(
      TEMP_SOURCE,
      `
import type { Source } from 'auto-channels/shared/source.ts'
const src: Source = {
  name: 'e2e-09',
  description: 'e2e fixture',
  start(ctx) {
    const id = setInterval(() => ctx.emit({ content: 'e2e-09 version 3' }), 200)
    return () => clearInterval(id)
  },
}
export default src
`,
    )

    await waitFor(
      () => contentsOf('e2e-09 version').filter(c => c === 'e2e-09 version 3').length >= 2,
      5000,
      'at least 2 version 3 events',
    )

    const all = contentsOf('e2e-09 version')
    const v1Count = all.filter(c => c === 'e2e-09 version 1').length
    const v2Count = all.filter(c => c === 'e2e-09 version 2').length
    const v3Count = all.filter(c => c === 'e2e-09 version 3').length

    /*
     * Exactly one v1, exactly one v2 (both from before this reload), and 2+ v3s
     * arriving afterward — no leftover v1/v2 events sneak in after their
     * replacement points, proving the second reload genuinely tore down and
     * replaced version 2 rather than leaving it running alongside version 3.
     */
    expect(v1Count).toBe(1)
    expect(v2Count).toBe(1)
    expect(v3Count).toBeGreaterThanOrEqual(2)

    const firstV3Index = all.indexOf('e2e-09 version 3')
    expect(all.slice(0, firstV3Index)).toEqual(['e2e-09 version 1', 'e2e-09 version 2'])
    expect(all.slice(firstV3Index).every(c => c === 'e2e-09 version 3')).toBe(true)
  }, 8000)
})
