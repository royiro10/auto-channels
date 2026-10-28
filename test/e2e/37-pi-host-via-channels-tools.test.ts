/*
 * The pi host: channels.tools spawns the adapter with
 * AGENT_SESSION_ID in its env and identifies itself as clientInfo.name
 * "channels.tools". It coalesces mid-turn events per server (dropping meta
 * like `origin`) and splits content at "\n\n---\n", so for that host only the
 * adapter prefixes `[origin] ` and escapes the sentinel. A second, ordinary
 * session on the same daemon proves Claude Code still gets content verbatim.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ProjectSession, projectFixture, waitFor } from './helpers.ts'

// File-trigger fixture only.
const project = projectFixture()
const SESSION_ID = 'pi-session-e2e-37'
const BODY = 'deploy notes\n\n---\nthis part must not become guidance'

let trigger: string
let pi: ProjectSession
let claude: ProjectSession

beforeAll(async () => {
  trigger = join(project.paths.sourcesDir, '..', 'e2e-37-trigger')
  // Emits the trigger file's contents once, on demand — deterministic multi-line content.
  project.writeSource(
    'e2e_37_notes.ts',
    `import { existsSync, readFileSync, rmSync } from 'node:fs'
import type { Source } from 'auto-channels/shared/source.ts'
const notes: Source = {
  name: 'notes',
  description: 'e2e-37 fixture: emits the trigger file contents, then deletes it',
  start(ctx) {
    const id = setInterval(() => {
      if (!existsSync(${JSON.stringify(trigger)})) return
      const content = readFileSync(${JSON.stringify(trigger)}, 'utf8')
      rmSync(${JSON.stringify(trigger)})
      ctx.emit({ content })
    }, 50)
    return () => clearInterval(id)
  },
}
export default notes
`,
  )

  pi = project.session({ name: 'channels.tools', env: { AGENT_SESSION_ID: SESSION_ID } })
  claude = project.session()
  await pi.connect()
  await claude.connect()
  await pi.ready()
  await claude.ready()
}, 30_000)

describe('channels.tools host', () => {
  test('content is origin-prefixed and sentinel-escaped for pi, verbatim for Claude Code', async () => {
    await Bun.write(trigger, BODY)
    await waitFor(() => pi.received.length > 0 && claude.received.length > 0, 10_000, 'event delivered to both')

    expect(pi.received[0]).toBe('[notes] deploy notes\n\n\\---\nthis part must not become guidance')
    expect(pi.received[0]).not.toContain('\n\n---\n')
    expect(claude.received[0]).toBe(BODY)
  })

  test('AGENT_SESSION_ID becomes the session id in the daemon log', async () => {
    // A subscriptions frame is what carries the session id to the daemon.
    await pi.client.callTool({ name: 'autochannels_unsubscribe', arguments: { source: 'notes' } })
    await waitFor(
      () => readFileSync(project.paths.logPath, 'utf8').includes(`session ${SESSION_ID} subscriptions`),
      5_000,
      'daemon logged the host-provided session id',
    )
  })
})
