/*
 * Pins daemon.status.json's lifecycle: absent before
 * startup, `sources: []` once listening, the loaded source with
 * `lastEmitAt: null` before its first emit, lastEmitAt updated on each emit,
 * and removed on graceful shutdown.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { type ProjectSession, projectFixture, seed, waitFor, waitForSource } from './helpers.ts'

// The reader's side of the contract: external tools consume the plain JSON, so the shape is declared here.
const DaemonStatusSchema = z.object({
  pid: z.number(),
  startedAt: z.string(),
  connectedClients: z.number(),
  sources: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      file: z.string(),
      defaultSubscribed: z.boolean(),
      lastEmitAt: z.string().nullable(),
      lastError: z.object({ at: z.string(), message: z.string() }).nullable(),
    }),
  ),
})

const TICK = 'status-ticker tick'

const TICKER = `import type { Source } from 'auto-channels/shared/source.ts'
const ticker: Source = {
  name: 'status-ticker',
  description: 'e2e-36 fixture: source whose lastEmitAt the status file must track',
  start(ctx) {
    const id = setInterval(() => ctx.emit({ content: ${JSON.stringify(TICK)} }), 200)
    return () => clearInterval(id)
  },
}
export default ticker
`

// Interval fixture only.
const project = projectFixture({ sources: { 'ticker.ts': TICKER } })

let session: ProjectSession

// Anything next to the status file that isn't it: a leftover temp file from a write.
function statusArtifacts(runDir: string): string[] {
  return readdirSync(runDir).filter(name => name.startsWith('daemon.status.json.'))
}

function readStatus() {
  return DaemonStatusSchema.parse(JSON.parse(readFileSync(project.paths.statusPath, 'utf8')))
}

beforeAll(async () => {
  expect(existsSync(project.paths.statusPath)).toBe(false) // nothing before the daemon has ever run

  session = project.session()
  await session.connect()
  await session.ready()
}, 30_000)

describe('daemon.status.json — the external liveness/health surface', () => {
  test('appears the instant the daemon is listening, before any source has loaded', async () => {
    await waitFor(() => existsSync(project.paths.statusPath), 10_000, 'status file to appear')
    const status = readStatus()
    expect(status.pid).toBeGreaterThan(0)
    expect(new Date(status.startedAt).toString()).not.toBe('Invalid Date')
    // Read early enough it may still be empty; the source-loaded assertion below is the real proof.
    expect(Array.isArray(status.sources)).toBe(true)
  })

  test('reports connectedClients >= 1 while this session holds a live socket', async () => {
    // The signal a watchdog polls for: a healthy daemon with connectedClients
    // at 0 would mean every event is firing into a void (the silent outage a
    // real deployment hit). We have one connected session,
    // so it must be at least 1.
    await waitFor(() => readStatus().connectedClients >= 1, 10_000, 'connectedClients to reflect this session')
  })

  test('gains the loaded source with lastEmitAt: null, then a real timestamp after its first tick', async () => {
    await waitFor(
      () => readStatus().sources.some(s => s.name === 'status-ticker'),
      10_000,
      'status-ticker to appear in the status file',
    )
    // Caught early enough (before the first 200ms tick) at least once across
    // this suite's history — assert the field exists in the right shape
    // rather than racing to observe null specifically.
    const beforeTick = readStatus().sources.find(s => s.name === 'status-ticker')
    expect(beforeTick).toBeDefined()
    expect(beforeTick?.lastEmitAt === null || typeof beforeTick?.lastEmitAt === 'string').toBe(true)

    await waitFor(() => session.received.includes(TICK), 10_000, 'first tick to be delivered')
    await waitFor(
      () => readStatus().sources.find(s => s.name === 'status-ticker')?.lastEmitAt !== null,
      5000,
      'lastEmitAt to become non-null after the first tick',
    )
    const afterFirstTick = readStatus().sources.find(s => s.name === 'status-ticker')?.lastEmitAt
    expect(typeof afterFirstTick).toBe('string')

    // A later tick moves lastEmitAt forward — proving it's live-updated, not
    // just set once at load time.
    await new Promise(resolve => setTimeout(resolve, 250))
    await waitFor(
      () => {
        const now = readStatus().sources.find(s => s.name === 'status-ticker')?.lastEmitAt
        return now !== undefined && now !== afterFirstTick
      },
      5000,
      'lastEmitAt to advance on a subsequent tick',
    )
  })

  // A write replaces the file by rename, so a reader sees a whole old or new snapshot, never a torn one.
  test('each write replaces the file (the inode changes across ticks)', async () => {
    const inode = statSync(project.paths.statusPath).ino
    await waitFor(() => statSync(project.paths.statusPath).ino !== inode, 5000, 'a write to replace the inode')
  }, 10_000)

  test('while writes fail on a blocked temp path, the status file keeps its last good content; then writes resume', async () => {
    const tmpPath = `${project.paths.statusPath}.${project.daemonPid()}.tmp`
    mkdirSync(join(tmpPath, 'blocker'), { recursive: true })
    const failing = project.logCursor()
    await waitFor(() => failing.since().includes('failed to write status'), 5000, 'a failed write')
    const lastGood = readFileSync(project.paths.statusPath, 'utf8')
    const again = project.logCursor()
    await waitFor(() => again.since().includes('failed to write status'), 5000, 'another failed write')
    expect(readFileSync(project.paths.statusPath, 'utf8')).toBe(lastGood)
    expect(() => readStatus()).not.toThrow()

    rmSync(tmpPath, { recursive: true })
    await waitFor(() => readFileSync(project.paths.statusPath, 'utf8') !== lastGood, 5000, 'writes to resume')
    expect(() => readStatus()).not.toThrow()
  }, 20_000)

  test('a reader polling every 2 ms never sees a torn file over 2 s of 50 ms ticks (regression guard)', async () => {
    project.writeSource(
      'fast.ts',
      `import type { Source } from 'auto-channels/shared/source.ts'
const fast: Source = {
  name: 'fast-ticker',
  description: 'e2e-36 fixture: frequent status writes for the torn-read guard',
  start(ctx) {
    const id = setInterval(() => ctx.emit({ content: 'fast tick' }), 50)
    return () => clearInterval(id)
  },
}
export default fast
`,
    )
    await waitForSource(session.client, 'fast-ticker', true)
    const contents = new Set<string>()
    let parseErrors = 0
    for (const end = Date.now() + 2000; Date.now() < end; await Bun.sleep(2)) {
      try {
        const text = readFileSync(project.paths.statusPath, 'utf8')
        JSON.parse(text)
        contents.add(text)
      } catch {
        parseErrors++
      }
    }
    project.removeSource('fast.ts')
    await waitForSource(session.client, 'fast-ticker', false)
    expect(parseErrors).toBe(0)
    expect(contents.size).toBeGreaterThan(10) // the file really was rewritten throughout
  }, 15_000)

  test('is removed on graceful shutdown, mirroring daemon.pid rather than left stale', async () => {
    expect(existsSync(project.paths.statusPath)).toBe(true) // sanity: still present before we kill it
    const pid = project.daemonPid() as number
    process.kill(pid, 'SIGTERM')
    await waitFor(() => !existsSync(project.paths.pidPath), 10_000, 'daemon.pid removed on graceful shutdown')
    expect(existsSync(project.paths.statusPath)).toBe(false)
    expect(statusArtifacts(project.paths.runDir)).toEqual([])
  }, 15_000)
})

/*
 * The status file is a side channel, so a failing write (here: a
 * non-empty directory squatting on its path) must be logged and survived —
 * it used to throw from the listen callback, a timer emit, a webhook
 * request, or a (dis)connection, crashing the daemon or failing delivery.
 */
describe('status persistence is best-effort and after delivery', () => {
  const faulty = projectFixture({ sources: { 'ticker.ts': TICKER, 'webhook.ts': seed('webhook') } })
  let first: ProjectSession

  const ticks = () => first.received.filter(content => content === TICK).length
  // Retried: a status write can land between the rm and the mkdir.
  const blockStatus = () =>
    waitFor(
      () => {
        rmSync(faulty.paths.statusPath, { recursive: true, force: true })
        try {
          mkdirSync(join(faulty.paths.statusPath, 'blocker'), { recursive: true })
          return true
        } catch {
          return false
        }
      },
      2000,
      'the status path blocked by a directory',
    )
  const statusParses = () => {
    try {
      DaemonStatusSchema.parse(JSON.parse(readFileSync(faulty.paths.statusPath, 'utf8')))
      return true
    } catch {
      return false
    }
  }

  beforeAll(async () => {
    mkdirSync(faulty.paths.runDir, { recursive: true })
    await blockStatus()
    first = faulty.session()
    await first.connect()
    await first.ready()
  }, 30_000)

  test('(a) blocked from startup: ticks flow from one stable daemon and the failure is logged', async () => {
    await waitFor(() => ticks() >= 1, 10_000, 'the first tick')
    const pid = faulty.daemonPid()
    const before = ticks()
    await waitFor(() => ticks() >= before + 3, 5000, '3 more ticks')
    expect(faulty.daemonPid()).toBe(pid)
    expect(readFileSync(faulty.paths.logPath, 'utf8')).toContain('failed to write status')
  }, 20_000)

  test('(b) blocked after a healthy start: webhook, ticks and (dis)connections keep working on one daemon', async () => {
    rmSync(faulty.paths.statusPath, { recursive: true })
    await waitFor(statusParses, 5000, 'a healthy status file')
    const pid = faulty.daemonPid()
    const log = faulty.logCursor()
    await blockStatus()

    const body = 'e2e-36 webhook while status writes fail'
    const response = await fetch(`http://127.0.0.1:${faulty.port}/`, {
      method: 'POST',
      headers: { 'X-Sender': 'dev' },
      body,
    })
    expect(response.status).toBe(200)
    await waitFor(() => first.received.includes(body), 5000, 'the webhook event delivered')
    const before = ticks()
    await waitFor(() => ticks() >= before + 3, 5000, '3 more ticks')
    const second = faulty.session({ name: 'second' })
    await second.connect()
    await waitFor(() => second.connectCount >= 1, 10_000, 'the second session connected')
    await second.close()
    await waitFor(() => log.since().includes('adapter disconnected (1 total)'), 5000, 'the daemon to see it leave')
    expect(log.since()).toContain('failed to write status')
    expect(faulty.daemonPid()).toBe(pid)
    // Sampled until clear: a temp file exists only inside one write call, so a leftover would persist.
    await waitFor(() => statusArtifacts(faulty.paths.runDir).length === 0, 1000, 'no daemon.status.json.* left over')

    rmSync(faulty.paths.statusPath, { recursive: true })
    await waitFor(statusParses, 5000, 'the next write to recreate a parseable status file')
    expect(faulty.daemonPid()).toBe(pid)
  }, 30_000)

  test('SIGTERM still removes daemon.pid and releases the lock while the status path is blocked', async () => {
    await first.close() // no adapter left to respawn a daemon after the kill
    await blockStatus()
    await faulty.killDaemon()
    expect(existsSync(faulty.paths.pidPath)).toBe(false)
    expect(existsSync(join(faulty.paths.runDir, 'daemon.lock'))).toBe(false)
  }, 20_000)
})
