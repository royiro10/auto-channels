/*
 * Pins that an adapter-spawned daemon's diagnostics land in the run dir's
 * daemon.log instead of being discarded.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { projectFixture, seed, waitFor } from './helpers.ts'

const project = projectFixture({
  sources: { 'webhook.ts': seed('webhook'), 'cron.ts': seed('cron'), 'filedrop.ts': seed('filedrop') },
})

beforeAll(async () => {
  const session = project.session()
  await session.connect()
  await session.ready({ health: true })
}, 20_000)

describe('the daemon spawned by the adapter persists its logs instead of discarding them', () => {
  test('daemon.log exists in the run dir and contains real log output', async () => {
    await waitFor(() => existsSync(project.paths.logPath), 5000, 'daemon.log to be created')

    /*
     * Content from more than one source -- proves this isn't a fluke of one
     * specific log call, but the daemon's whole stdio being captured. Polled,
     * not read once: the file is written by another process, and the daemon
     * logs "adapter connected" from its own side of the socket, which can land
     * just after the adapter's own connect line already reached this test.
     */
    const expected = ['[daemon] listening on', '[sources] loaded webhook (webhook.ts)', '[daemon] adapter connected']
    const content = () => readFileSync(project.paths.logPath, 'utf8')
    await waitFor(() => expected.every(line => content().includes(line)), 5000, 'all expected daemon.log lines')
    for (const line of expected) expect(content()).toContain(line)
  })
})
