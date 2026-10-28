/*
 * Pins that a webhook port collision between two projects fails only the
 * losing source: its daemon survives, its other source keeps delivering, the
 * failure is in its daemon.log, and the winning project's webhook is untouched.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { type ProjectSession, projectFixture, waitFor } from './helpers.ts'

const HOOK = `import { webhook } from 'auto-channels/builtins'
export default webhook({ allowedSenders: ['dev'] })
`

const PROJECT_A = projectFixture({ sources: { 'hook.ts': HOOK } })
const PROJECT_B = projectFixture({
  sources: {
    'hook.ts': HOOK,
    /*
     * Project B additionally has a source that must keep working while its
     * webhook loses the port race.
     */
    'ticker.ts': `import type { Source } from 'auto-channels/shared/source.ts'
const ticker: Source = {
  name: 'ticker-b',
  description: 'e2e-34 fixture: must keep delivering while the webhook fails to bind',
  start(ctx) {
    const id = setInterval(() => ctx.emit({ content: 'b-still-alive' }), 150)
    return () => clearInterval(id)
  },
}
export default ticker
`,
  },
})

let sessionA: ProjectSession
let sessionB: ProjectSession

beforeAll(async () => {
  // Deterministic ordering: A must own the port before B ever tries it.
  sessionA = PROJECT_A.session({ name: 'port-winner-session' })
  await sessionA.connect()
  await sessionA.ready({ health: true })

  /*
   * Both projects deliberately claim A's port -- the collision under test.
   * An env override, so the lease's allocation retry does not apply.
   */
  sessionB = PROJECT_B.session({ name: 'port-loser-session', env: { WEBHOOK_PORT: String(PROJECT_A.port) } })
  await sessionB.connect()
  await sessionB.ready()
}, 40_000)

describe('a webhook port collision between two projects is crash-isolated', () => {
  test("project B's daemon survives the bind failure and its other source keeps delivering", async () => {
    await waitFor(
      () => sessionB.received.filter(content => content === 'b-still-alive').length >= 3,
      10_000,
      "project B's ticker to deliver despite the webhook bind failure",
    )
    expect(existsSync(PROJECT_B.paths.socketPath)).toBe(true) // B's daemon is up, not crashed
  }, 15_000)

  test("the bind failure is diagnosable in project B's own daemon.log", async () => {
    await waitFor(
      () => {
        const logPath = PROJECT_B.paths.logPath
        if (!existsSync(logPath)) return false
        const log = readFileSync(logPath, 'utf8')
        return log.includes('hook.ts') && /failed|in use|EADDRINUSE/i.test(log)
      },
      10_000,
      "B's daemon.log to record the webhook load failure",
    )
  })

  test("project A's webhook -- the port winner -- still works end to end", async () => {
    const res = await fetch(`http://127.0.0.1:${PROJECT_A.port}/`, {
      method: 'POST',
      headers: { 'X-Sender': 'dev' },
      body: 'a-owns-this-port',
    })
    expect(res.status).toBe(200)
    await waitFor(() => sessionA.received.includes('a-owns-this-port'), 5000, "project A's webhook delivery")
    // ...and it delivers to A only: B's daemon never had this event.
    expect(sessionB.received).not.toContain('a-owns-this-port')
  }, 15_000)
})
