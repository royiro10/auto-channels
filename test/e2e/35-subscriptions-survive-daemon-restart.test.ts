/*
 * Pins intent replay across a daemon crash: after a SIGKILL, the respawned
 * daemon receives the session's unsubscribe before that session sees any
 * event it opted out of, and resubscribing proves the pipeline is live.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { type ProjectSession, projectFixture, waitFor } from './helpers.ts'

const TICK = 'restart-ticker tick'

// Interval fixture only.
const project = projectFixture({
  sources: {
    'ticker.ts': `import type { Source } from 'auto-channels/shared/source.ts'
const ticker: Source = {
  name: 'restart-ticker',
  description: 'e2e-35 fixture: steady traffic to observe subscription state across a daemon restart',
  start(ctx) {
    const id = setInterval(() => ctx.emit({ content: ${JSON.stringify(TICK)} }), 200)
    return () => clearInterval(id)
  },
}
export default ticker
`,
  },
})

let session: ProjectSession

function ticksSince(mark: number): number {
  return session.received.slice(mark).filter(content => content === TICK).length
}

beforeAll(async () => {
  session = project.session()
  await session.connect()
  await session.ready()
  await waitFor(() => session.received.includes(TICK), 10_000, 'ticker delivering before any of the action')
}, 30_000)

describe('subscription state survives a daemon SIGKILL and respawn', () => {
  test('unsubscribe silences the ticker; SIGKILL + respawn does NOT revert it; resubscribe restores it', async () => {
    const unsubscribeLog = project.logCursor()
    await session.client.callTool({ name: 'autochannels_unsubscribe', arguments: { source: 'restart-ticker' } })
    /*
     * The adapter's mute veto runs inside the tool handler, so the count at
     * the tool's return is final. The daemon's own log line proves
     * it applied the unsubscribe; then a full second of scheduled ticks (5x
     * the 200ms interval) must produce nothing.
     */
    const quietMark = session.received.length
    await waitFor(() => unsubscribeLog.since().includes('-[restart-ticker]'), 5000, 'daemon to apply the unsubscribe')
    await new Promise(resolve => setTimeout(resolve, 1000))
    expect(ticksSince(quietMark)).toBe(0)

    /*
     * Kill the daemon the hard way: no shutdown code runs, socket and
     * pidfile are left behind as stale artifacts for the next startup.
     */
    const oldPid = project.daemonPid() as number
    const connectsBeforeKill = session.connectCount
    const respawnLog = project.logCursor()
    process.kill(oldPid, 'SIGKILL')

    /*
     * The adapter's reconnect loop respawns a fresh daemon (stale-artifact
     * recovery included) and reconnects -- a new stderr connect line proves it.
     */
    await waitFor(() => session.connectCount > connectsBeforeKill, 20_000, 'adapter reconnected to a respawned daemon')
    const reconnectMark = session.received.length
    const newPid = project.daemonPid()
    expect(newPid).not.toBe(oldPid) // genuinely a fresh process, not a survivor
    expect(existsSync(project.paths.socketPath)).toBe(true)

    /*
     * The money assertion. The fresh daemon knows nothing; the adapter's
     * full-state replay on reconnect keeps it filtering, and the adapter's
     * mute veto drops any tick the daemon sent in the connect-then-replay
     * window -- so nothing arrives from the reconnect on, with no
     * drain allowance. Wait for the fresh daemon to log the replayed state,
     * then a full second of scheduled ticks must still deliver nothing.
     */
    await waitFor(() => respawnLog.since().includes('-[restart-ticker]'), 10_000, 'fresh daemon to apply the replay')
    await new Promise(resolve => setTimeout(resolve, 1000))
    expect(ticksSince(reconnectMark)).toBe(0)

    /*
     * And the recovered pipeline is live, not just quiet: resubscribing
     * brings the ticks back through the NEW daemon.
     */
    await session.client.callTool({ name: 'autochannels_subscribe', arguments: { source: 'restart-ticker' } })
    const resubscribeMark = session.received.length
    await waitFor(() => ticksSince(resubscribeMark) >= 2, 10_000, 'ticks to resume after resubscribing')
  }, 45_000)
})
