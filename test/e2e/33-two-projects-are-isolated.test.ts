/*
 * Pins project isolation: two projects running at once get two daemons with
 * separate run-dir artifacts, and each session receives only its own
 * project's events.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { type ProjectSession, projectFixture, waitFor } from './helpers.ts'

// Two disjoint "projects": separate roots, run dirs, sources dirs and ports.
const PROJECT_A = projectFixture({
  sources: {
    /*
     * Project A: a real webhook (the builtin, activated the way a consumer
     * would) gated by its own allowedSenders.
     */
    'hook.ts': `import { webhook } from 'auto-channels/builtins'
export default webhook({ allowedSenders: ['dev'] })
`,
  },
})
const PROJECT_B = projectFixture({
  sources: {
    /*
     * Project B: a ticker, so B's session has traffic that must NEVER show up
     * in A's session.
     */
    'ticker.ts': `import type { Source } from 'auto-channels/shared/source.ts'
const ticker: Source = {
  name: 'ticker-b',
  description: 'e2e-33 fixture: project B traffic that must never leak into project A',
  start(ctx) {
    const id = setInterval(() => ctx.emit({ content: 'tick-from-project-b' }), 150)
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
  sessionA = PROJECT_A.session({ name: 'project-a-session' })
  sessionB = PROJECT_B.session({ name: 'project-b-session' })
  await Promise.all([sessionA.connect(), sessionB.connect()])
  await sessionB.ready()
  await sessionA.ready({ health: true })
}, 30_000)

describe('two projects on one host are fully isolated', () => {
  test('two distinct daemon processes, each with its own runtime artifacts', () => {
    const pidA = PROJECT_A.daemonPid()
    const pidB = PROJECT_B.daemonPid()
    expect(pidA).not.toBe(pidB)
    expect(existsSync(PROJECT_A.paths.socketPath)).toBe(true)
    expect(existsSync(PROJECT_B.paths.socketPath)).toBe(true)
    expect(existsSync(PROJECT_A.paths.logPath)).toBe(true)
    expect(existsSync(PROJECT_B.paths.logPath)).toBe(true)
  })

  test("each session receives its own project's events and nothing from the other", async () => {
    await fetch(`http://127.0.0.1:${PROJECT_A.port}/`, {
      method: 'POST',
      headers: { 'X-Sender': 'dev' },
      body: 'webhook-event-for-project-a',
    })

    /*
     * Positive confirmation both pipelines are live BEFORE asserting the
     * negatives, so "nothing leaked" can't pass vacuously because nothing
     * was delivered at all.
     */
    await waitFor(() => sessionA.received.includes('webhook-event-for-project-a'), 5000, "project A's webhook event")
    await waitFor(
      () => sessionB.received.filter(content => content === 'tick-from-project-b').length >= 3,
      5000,
      "project B's ticker events",
    )

    expect(sessionA.received).not.toContain('tick-from-project-b')
    expect(sessionB.received).not.toContain('webhook-event-for-project-a')
  }, 15_000)
})
