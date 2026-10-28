/*
 * Pins the idle rule: with no client for a full
 * DAEMON_IDLE_SHUTDOWN_MS window, the daemon stops gracefully (sources
 * stopped, run-dir artifacts removed), and it never exits while a client
 * stays connected past the window.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type ProjectSession, projectFixture, seed, waitFor } from './helpers.ts'

/*
 * Long enough that connect/handshake churn can't trip it, short enough that
 * the test proves the idle exit in seconds rather than the 60s default.
 */
const IDLE_SHUTDOWN_MS = 1500

/*
 * The shared seeds, so webhook.ts actually loads -- its health endpoint
 * doubles as the "daemon is fully up" probe here.
 */
const project = projectFixture({
  sources: { 'webhook.ts': seed('webhook'), 'cron.ts': seed('cron'), 'filedrop.ts': seed('filedrop') },
  env: { DAEMON_IDLE_SHUTDOWN_MS: String(IDLE_SHUTDOWN_MS) },
})

let session: ProjectSession

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

beforeAll(async () => {
  session = project.session()
  await session.connect()
  await session.ready({ health: true })
}, 20_000)

describe('the daemon exits by itself once its last client has been gone for the grace window', () => {
  test('stays alive while a client is connected well past the window, then exits after the client leaves', async () => {
    const pid = project.daemonPid()
    expect(pid).toBeDefined()
    if (pid === undefined) return

    /*
     * Connected for 2x the grace window: the countdown must cancel on
     * connect, not behave like a wall-clock TTL from daemon startup.
     */
    await new Promise(resolve => setTimeout(resolve, IDLE_SHUTDOWN_MS * 2))
    expect(isAlive(pid)).toBe(true)

    /*
     * Last (only) client leaves. client.close() closes the adapter's stdin;
     * the adapter exits promptly (see e2e-28), dropping the daemon to zero
     * connections.
     */
    await session.close()

    await waitFor(() => !isAlive(pid), IDLE_SHUTDOWN_MS * 4, 'the daemon process to exit on its own')

    /*
     * Graceful shutdown, not just process death: the same cleanup a SIGTERM
     * runs -- no stale socket, pidfile, or startup lock left for the next
     * daemon to have to detect and recover from.
     */
    await waitFor(
      () =>
        !existsSync(project.paths.socketPath) &&
        !existsSync(project.paths.pidPath) &&
        !existsSync(join(project.paths.runDir, 'daemon.lock')),
      5000,
      'socket, pidfile, and startup lock to be cleaned up',
    )
  }, 20_000)
})
