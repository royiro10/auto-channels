/*
 * Pins the installed-consumer story end to end: a separate project under /tmp
 * is scaffolded by the real `init --claude --pi` (with its real `bun install`),
 * the adapter runs from the scaffolded registration path, a consumer source and
 * a builtin activation file load from the installed package, and every runtime
 * artifact lands inside .channels/.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ProjectSession, projectFixture, type ReceivedEvent, waitFor } from './helpers.ts'

const PACKAGE_DIR = join(import.meta.dir, '..', '..')
// A random, short, socket-safe root under /tmp with its own port lease; nothing pre-created in it.
const project = projectFixture({ mode: 'installed' })

interface ServerEntry {
  args: [entry: string]
  env: Record<string, string>
}

let CONSUMER_DIR: string
let received: ReceivedEvent[]

/*
 * A second session spawned from the scaffolded .pi/channels.json and
 * identifying as channels.tools (pi's channel host) —
 * both host registrations must work from the same installed package.
 */
let pi: ProjectSession

beforeAll(async () => {
  CONSUMER_DIR = project.root

  /*
   * The real thing, not a simulation of it: cli.ts's init scaffolds the
   * project AND runs bun install inside .channels/ (init generates the
   * file: dependency pointing at this repo's package -- the documented
   * pre-publish behavior).
   */
  const init = Bun.spawnSync(['bun', join(PACKAGE_DIR, 'src', 'cli.ts'), 'init', '--claude', '--pi'], {
    cwd: CONSUMER_DIR,
  })
  if (init.exitCode !== 0) {
    throw new Error(`auto-channels init failed:\n${init.stdout.toString()}\n${init.stderr.toString()}`)
  }

  /*
   * A consumer-authored source, dropped into the scaffolded sources dir
   * before the daemon starts (so it loads at cold start).
   */
  writeFileSync(
    join(CONSUMER_DIR, '.channels', 'sources', 'greeter.ts'),
    `
import type { Source } from 'auto-channels/shared/source.ts'
const greeter: Source = {
  name: 'greeter',
  description: 'e2e fixture: a real external consumer project greeting source',
  start(ctx) {
    // Ticks repeatedly rather than emitting once -- this source loads at
    // daemon startup (before the client below even connects, since the
    // whole point is a cold-start consumer project), so a single immediate
    // emit races the adapter's own connection to the daemon exactly like
    // the platform's documented readiness race (fire-and-forget, dropped if
    // nobody's listening yet). Repeating means a later tick gets through
    // once the client is actually connected, instead of the test depending
    // on winning that race.
    const id = setInterval(() => ctx.emit({ content: 'hello from a real external consumer project' }), 200)
    return () => clearInterval(id)
  },
}
export default greeter
`,
  )

  /*
   * The one-line builtin activation a real consumer writes (init scaffolds no
   * active sources on purpose): the webhook builtin, imported from the copy
   * of auto-channels that bun install just placed in .channels/node_modules.
   */
  writeFileSync(
    join(CONSUMER_DIR, '.channels', 'sources', 'hook.ts'),
    `
import { webhook } from 'auto-channels/builtins'
export default webhook({ allowedSenders: ['dev'] })
`,
  )

  /*
   * Spawn the adapter exactly as the scaffolded .mcp.json specifies: the
   * entry script and env are read from the file itself rather than restated,
   * so this test can't silently diverge from what init actually writes.
   */
  const mcp = JSON.parse(readFileSync(join(CONSUMER_DIR, '.mcp.json'), 'utf8')) as {
    mcpServers: Record<'auto-channels', ServerEntry>
  }
  const mcpEntry = mcp.mcpServers['auto-channels']
  const session = project.session({ entry: mcpEntry.args[0], env: mcpEntry.env })
  received = session.notifications
  await session.connect()
  await session.ready()

  const piConfig = JSON.parse(readFileSync(join(CONSUMER_DIR, '.pi', 'channels.json'), 'utf8')) as {
    channelServers: Record<'auto-channels', ServerEntry>
  }
  const piEntry = piConfig.channelServers['auto-channels']
  pi = project.session({ name: 'channels.tools', entry: piEntry.args[0], env: piEntry.env })
  await pi.connect()
  await pi.ready()
}, 60_000)

describe('works as an installed package in a real, init-scaffolded consumer project', () => {
  test("the consumer's own source loads and emits, gated by its activation file, with no extra config", async () => {
    await waitFor(
      () => received.some(event => event.content === 'hello from a real external consumer project'),
      10_000,
      "the consumer project's own custom source to load and emit",
    )

    /*
     * The webhook builtin -- enabled by the consumer's one-line activation
     * file, running from the installed package -- is live too, gated by the
     * activation file's allowedSenders ('dev' allowed, strangers rejected).
     */
    const ok = await fetch(`http://127.0.0.1:${project.port}/`, {
      method: 'POST',
      headers: { 'X-Sender': 'dev' },
      body: 'builtin webhook works from the installed package',
    })
    expect(ok.status).toBe(200)
    const forbidden = await fetch(`http://127.0.0.1:${project.port}/`, {
      method: 'POST',
      headers: { 'X-Sender': 'stranger' },
      body: 'nope',
    })
    expect(forbidden.status).toBe(403)
  })

  test('the .pi/channels.json registration works too, and pi sees origin-prefixed content', async () => {
    await waitFor(
      () => pi.received.includes('[greeter] hello from a real external consumer project'),
      10_000,
      'the consumer source reaching the pi-registered session, origin-prefixed',
    )
  })

  test('every runtime artifact lands inside .channels/, nothing new at the host root', () => {
    expect(existsSync(join(CONSUMER_DIR, '.channels', 'run', 'daemon.sock'))).toBe(true)
    expect(existsSync(join(CONSUMER_DIR, '.channels', 'run', 'daemon.log'))).toBe(true)
    // The old flat-layout locations must NOT reappear at the host root.
    expect(existsSync(join(CONSUMER_DIR, '.run'))).toBe(false)
    expect(existsSync(join(CONSUMER_DIR, 'sources'))).toBe(false)
    expect(existsSync(join(CONSUMER_DIR, 'dropbox'))).toBe(false)
    expect(existsSync(join(CONSUMER_DIR, 'node_modules'))).toBe(false)
    expect(existsSync(join(CONSUMER_DIR, 'package.json'))).toBe(false)
  })
})
