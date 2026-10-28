/*
 * Pins that the adapter exits promptly when its stdin closes, the way a host
 * ends a session, rather than lingering as an orphan.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { projectFixture, waitFor } from './helpers.ts'

// This test doesn't care what sources are loaded (it only exercises stdin-close behavior), so it seeds none.
const project = projectFixture()

describe('the adapter exits promptly when its stdin closes, without needing SIGTERM', () => {
  test('closing stdin (not killing the process) makes the adapter exit on its own, well under 2 seconds', async () => {
    const proc = project.spawnAdapter()

    /*
     * Give it a moment to actually start up (connect to/spawn the daemon)
     * before testing shutdown -- closing stdin before it's even finished
     * starting isn't the scenario under test.
     */
    await waitFor(() => existsSync(project.paths.pidPath), 10_000, 'daemon spawned by this adapter to be ready')

    const closedAt = Date.now()
    proc.stdin.end()

    await waitFor(() => proc.exitCode !== null, 4000, 'adapter process to exit after its stdin closed')
    const elapsedMs = Date.now() - closedAt

    /*
     * The MCP SDK's own client waits 2 full seconds before escalating to
     * SIGTERM -- a fixed adapter should exit well before that, on the
     * stdin-close signal alone, not by accident of the fallback timeout.
     */
    expect(elapsedMs).toBeLessThan(1500)
    expect(proc.exitCode).toBe(0)
  }, 20_000)
})
