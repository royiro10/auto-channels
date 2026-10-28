/*
 * An invalid daemon setting must fail the session at startup, visibly. The
 * adapter used to resolve only its own paths, so it connected fine while
 * every daemon it spawned died on the bad knob — an invisible respawn loop
 * in daemon.log. The adapter now resolves the whole config before
 * MCP connects and exits with the knob's error.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { projectFixture, waitFor } from './helpers.ts'

const ERROR = 'DAEMON_IDLE_SHUTDOWN_MS must be a positive integer, got "abc"'

const project = projectFixture()

describe('an invalid daemon setting fails the session at startup', () => {
  test('connect fails, stderr names the knob, and no daemon is ever started', async () => {
    const session = project.session({ env: { DAEMON_IDLE_SHUTDOWN_MS: 'abc' } })
    let closed = false
    session.client.onclose = () => {
      closed = true
    }

    await session.connect().catch(() => {}) // connect rejects, or the transport closes right after
    await waitFor(() => closed, 10_000, 'the transport to close (the adapter exited)')

    await waitFor(() => session.stderr.includes(ERROR), 5000, 'the knob error on stderr')

    /*
     * Negative window, started only after the adapter has exited: a spawned
     * daemon would publish daemon.pid (or at least append to daemon.log)
     * well within 3 s.
     */
    await new Promise(resolve => setTimeout(resolve, 3000))
    expect(existsSync(project.paths.pidPath)).toBe(false)
    expect(existsSync(project.paths.logPath)).toBe(false)
  }, 30_000)
})
