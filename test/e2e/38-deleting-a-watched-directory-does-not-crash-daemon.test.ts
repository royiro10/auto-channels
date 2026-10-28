/*
 * `rm -rf` of a watched directory (the filedrop dropbox, or sources/
 * itself) made the next dirWatch rescan throw ENOENT from a timer, crashing
 * the whole daemon and every unrelated source with it. Now a missing
 * directory reads as empty: its entries are reported removed, and a
 * recreated directory is picked up by the 1 s periodic rescan.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { listSourceNames, type ProjectSession, projectFixture, seed, waitFor, waitForSource } from './helpers.ts'

const TICK = 'e2e-38 tick'
const TICKER = `import type { Source } from 'auto-channels/shared/source.ts'
const ticker: Source = {
  name: 'e2e-38-ticker',
  description: 'e2e-38 fixture: unrelated traffic that must survive a watched directory being deleted',
  start(ctx) {
    const id = setInterval(() => ctx.emit({ content: ${JSON.stringify(TICK)} }), 200)
    return () => clearInterval(id)
  },
}
export default ticker
`

const project = projectFixture({ sources: { 'filedrop.ts': seed('filedrop'), 'ticker.ts': TICKER } })

let session: ProjectSession
let pid: number | undefined

function tickCount(): number {
  return session.received.filter(content => content === TICK).length
}

beforeAll(async () => {
  session = project.session()
  await session.connect()
  await session.ready({ sources: ['filedrop', 'e2e-38-ticker'] })
  pid = project.daemonPid()
}, 30_000)

describe('deleting a watched directory does not crash the daemon', () => {
  test('deleting the dropbox: the ticker keeps delivering from the same daemon', async () => {
    const before = tickCount()
    rmSync(project.paths.dropboxDir, { recursive: true })
    // 8 ticks of 200 ms outlast the 1 s periodic rescan that used to throw ENOENT.
    await waitFor(() => tickCount() >= before + 8, 10_000, '8 more ticks after the dropbox is deleted')
    expect(project.daemonPid()).toBe(pid)
  }, 15_000)

  test('deleting sources/: every source is retired, by the same daemon', async () => {
    rmSync(project.paths.sourcesDir, { recursive: true })
    await waitFor(async () => (await listSourceNames(session.client)).length === 0, 10_000, 'an empty registry')
    expect(project.daemonPid()).toBe(pid)
  }, 15_000)

  test('recreating sources/ and writing the ticker back loads it again', async () => {
    mkdirSync(project.paths.sourcesDir)
    project.writeSource('ticker.ts', TICKER)
    await waitForSource(session.client, 'e2e-38-ticker', true)
    expect(project.daemonPid()).toBe(pid)
  }, 15_000)
})
