/*
 * The daemon at its run-function interface: runDaemon in-process on a temp
 * config, read by raw sockets through createFrameReader('daemon'). Fixture
 * sources report to the test through globalThis.__daemonTest; their stop()s
 * are synchronous and complete. Real spawning stays in e2e.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordLastError, runDaemon } from '../../src/daemon/index.ts'
import { type Config, resolveConfig } from '../../src/shared/config.ts'
import { createFrameReader, type DaemonFrame } from '../../src/shared/protocol.ts'
import type { SourceContext } from '../../src/shared/source.ts'
import { waitFor } from '../../src/shared/testing.ts'

interface Probe {
  stops: number
  ctx?: SourceContext
  flood?: boolean
  ctxs: Record<string, SourceContext>
}
const probe = {} as Probe
;(globalThis as { __daemonTest?: Probe }).__daemonTest = probe

let tmp: string
let logs: string[]
let consoleError: ReturnType<typeof spyOn>
const sockets: Socket[] = []
const controllers: AbortController[] = []

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'daemon-test-'))
  mkdirSync(join(tmp, 'src'))
  probe.stops = 0
  probe.ctxs = {}
  delete probe.ctx
  delete probe.flood
  logs = []
  consoleError = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  })
})

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const controller of controllers.splice(0)) controller.abort('test cleanup')
  consoleError.mockRestore()
  rmSync(tmp, { recursive: true, force: true })
})

function configFor(env: Record<string, string> = {}): Config {
  return resolveConfig(
    { CHANNEL_RUN_DIR: join(tmp, 'run'), SOURCES_DIR: join(tmp, 'src'), DAEMON_IDLE_SHUTDOWN_MS: '60000', ...env },
    tmp,
  )
}

/** A running daemon plus the controller that stops it (aborted again in afterEach, harmlessly). */
function start(config: Config): { daemon: Promise<'already-running' | 'stopped'>; controller: AbortController } {
  const controller = new AbortController()
  controllers.push(controller)
  return { daemon: runDaemon(config, controller.signal), controller }
}

function writeSource(file: string, body: string): void {
  writeFileSync(join(tmp, 'src', file), `const p = globalThis.__daemonTest\nexport default ${body}\n`)
}

// A source that counts its stops and hands its context to the test.
const RECORDER = `{
  name: 'recorder',
  description: 'daemon.test fixture',
  start(ctx) {
    p.ctx = ctx
    return () => { p.stops++ }
  },
}`

// A source named `name` whose context the test drives through p.ctxs[name].
function emitter(name: string, defaultSubscribed = true): string {
  return `{
  name: '${name}',
  description: 'daemon.test fixture',
  defaultSubscribed: ${defaultSubscribed},
  start(ctx) {
    p.ctxs['${name}'] = ctx
  },
}`
}

function subscriptions(sessionId: string, subscribed: string[], unsubscribed: string[]): string {
  return `${JSON.stringify({ type: 'subscriptions', sessionId, subscribed, unsubscribed })}\n`
}

const events = (frames: DaemonFrame[]) => frames.flatMap(f => (f.type === 'event' ? [f.source] : []))

/** A raw client; frames (and the raw bytes) accumulate in order. */
async function client(config: Config): Promise<{ socket: Socket; frames: DaemonFrame[]; raw: Buffer[] }> {
  const socket = connect(config.socketPath)
  sockets.push(socket)
  const frames: DaemonFrame[] = []
  const raw: Buffer[] = []
  socket.on('data', (chunk: Buffer) => raw.push(chunk))
  socket.on(
    'data',
    createFrameReader(
      'daemon',
      frame => frames.push(frame),
      () => {},
    ),
  )
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  return { socket, frames, raw }
}

async function listening(config: Config): Promise<void> {
  await waitFor(() => existsSync(config.pidPath), 5000, 'the pidfile (listening)')
}

test('the sources frame comes first on a connection', async () => {
  writeSource(
    'ticker.ts',
    `{
  name: 'ticker',
  description: 'daemon.test fixture',
  start(ctx) {
    const id = setInterval(() => ctx.emit({ content: 'tick' }), 10)
    return () => clearInterval(id)
  },
}`,
  )
  const config = configFor()
  start(config)
  await listening(config)
  await waitFor(() => logs.some(l => l.includes('[sources] loaded ticker')), 5000, 'ticker loaded')

  const { frames } = await client(config)
  await waitFor(() => frames.some(f => f.type === 'event'), 5000, 'an event')
  expect(frames[0]).toEqual({
    type: 'sources',
    sources: [{ name: 'ticker', description: 'daemon.test fixture', file: 'ticker.ts', defaultSubscribed: true }],
  })
})

test("resolves 'already-running' while another holder owns the lock, touching nothing", async () => {
  const config = configFor()
  mkdirSync(config.lockPath, { recursive: true })
  writeFileSync(join(config.lockPath, 'owner'), `${process.pid}-someone-else`) // a live pid, a foreign token

  expect(await start(config).daemon).toBe('already-running')
  expect(existsSync(config.socketPath)).toBe(false)
  expect(existsSync(config.pidPath)).toBe(false)
  expect(existsSync(config.statusPath)).toBe(false)
  expect(readFileSync(join(config.lockPath, 'owner'), 'utf8')).toBe(`${process.pid}-someone-else`)
})

test("'stopped' removes the pid, status and socket files and releases the lock", async () => {
  const config = configFor()
  const { daemon, controller } = start(config)
  await listening(config)
  expect(existsSync(config.statusPath)).toBe(true)
  expect(existsSync(config.socketPath)).toBe(true)
  expect(existsSync(config.lockPath)).toBe(true)

  controller.abort('SIGTERM')
  expect(await daemon).toBe('stopped')
  expect(logs).toContain('[daemon] shutting down (SIGTERM)')
  for (const path of [config.pidPath, config.statusPath, config.socketPath, config.lockPath]) {
    expect(existsSync(path)).toBe(false)
  }
})

test('an abort racing an idle expiry stops the sources exactly once', async () => {
  writeSource('recorder.ts', RECORDER)
  const config = configFor({ DAEMON_IDLE_SHUTDOWN_MS: '300' })
  const startedAt = Date.now()
  const { daemon, controller } = start(config)
  await waitFor(() => probe.ctx !== undefined, 5000, 'recorder started')
  // The idle timer was armed just after this start, so it fires at about the same moment as this abort.
  await new Promise(resolve => setTimeout(resolve, Math.max(0, 300 - (Date.now() - startedAt))))
  controller.abort('SIGTERM')
  expect(await daemon).toBe('stopped')
  await new Promise(resolve => setTimeout(resolve, 300)) // past both triggers: neither may run the stop again
  expect(probe.stops).toBe(1)
  expect(logs.filter(l => l.includes('shutting down'))).toHaveLength(1)
})

test("regression guard: an already-aborted signal resolves 'stopped' with no socket file and the lock released", async () => {
  const config = configFor()
  const controller = new AbortController()
  controller.abort('SIGTERM')
  expect(await runDaemon(config, controller.signal)).toBe('stopped')
  expect(existsSync(config.socketPath)).toBe(false)
  expect(existsSync(config.lockPath)).toBe(false)
})

test('regression guard: a valid emit after runDaemon resolved leaves no status file behind', async () => {
  writeSource('recorder.ts', RECORDER)
  const config = configFor()
  const { daemon, controller } = start(config)
  await waitFor(() => probe.ctx !== undefined, 5000, 'recorder started')
  controller.abort('SIGTERM')
  expect(await daemon).toBe('stopped')

  probe.ctx?.emit({ content: 'late' })
  expect(existsSync(config.statusPath)).toBe(false)
})

test('a listen failure rejects runDaemon, releases the lock, and leaves no pidfile', async () => {
  const config = { ...configFor(), socketPath: join(tmp, 'missing', 'd.sock') }
  const { daemon } = start(config)
  await expect(daemon).rejects.toThrow()
  expect(logs).toContain('[daemon] shutting down (socket server error)')
  expect(existsSync(config.lockPath)).toBe(false)
  expect(existsSync(config.pidPath)).toBe(false)
})

test('sourcesDir naming a regular file rejects runDaemon, releases the lock, and leaves no pidfile', async () => {
  const file = join(tmp, 'not-a-dir')
  writeFileSync(file, '')
  const config = { ...configFor(), sourcesDir: file }
  const { daemon } = start(config)
  await expect(daemon).rejects.toThrow()
  expect(logs).toContain('[daemon] shutting down (startup failed)')
  expect(existsSync(config.lockPath)).toBe(false)
  expect(existsSync(config.pidPath)).toBe(false)
})

test('a directory at the socket path rejects runDaemon after the stop sequence, releasing the lock', async () => {
  const config = configFor()
  mkdirSync(config.socketPath, { recursive: true }) // rmSync without recursive cannot clear it
  const { daemon } = start(config)
  await expect(daemon).rejects.toThrow()
  expect(logs).toContain('[daemon] shutting down (startup failed)')
  expect(existsSync(config.lockPath)).toBe(false)
  expect(existsSync(config.pidPath)).toBe(false)
  expect(existsSync(config.statusPath)).toBe(false)
})

test('an explicit subscribe wins even when the same name is also in unsubscribed', async () => {
  /*
   * The adapter's tools keep the two lists disjoint, but the daemon must not
   * depend on every client being well-behaved: a contradictory frame resolves
   * predictably (subscribed wins), not by iteration order.
   */
  writeSource('a.ts', emitter('a'))
  writeSource('b.ts', emitter('b', false))
  const config = configFor()
  start(config)
  await listening(config)
  await waitFor(() => probe.ctxs.a !== undefined && probe.ctxs.b !== undefined, 5000, 'both sources started')
  const { socket, frames } = await client(config)
  socket.write(subscriptions('both', ['a', 'b'], ['a', 'b']))
  await waitFor(() => logs.some(l => l.includes('session both subscriptions')), 5000, 'the frame applied')

  probe.ctxs.a?.emit({ content: 'default' })
  probe.ctxs.b?.emit({ content: 'opt-in' })
  await waitFor(() => events(frames).length === 2, 5000, 'both events')
  expect(events(frames)).toEqual(['a', 'b'])
})

test('a subscriptions frame arriving after disconnect is ignored', async () => {
  /*
   * Twenty clients each write a frame and destroy their socket in the same
   * tick. Whatever order the frame and the close reach the daemon in, a
   * frame must never bring a gone client back: the count returns to zero and
   * the next client is the only one.
   */
  const config = configFor()
  start(config)
  await listening(config)
  const gone = await Promise.all(Array.from({ length: 20 }, () => client(config)))
  for (const [i, { socket }] of gone.entries()) {
    socket.write(subscriptions(`gone-${i}`, ['x'], []))
    socket.destroy()
  }
  await waitFor(() => logs.includes('[daemon] adapter disconnected (0 total)'), 5000, 'every client dropped')
  expect(JSON.parse(readFileSync(config.statusPath, 'utf8')).connectedClients).toBe(0)
  await client(config)
  await waitFor(() => logs.includes('[daemon] adapter connected (1 total)'), 5000, 'a fresh client counted alone')
  expect(JSON.parse(readFileSync(config.statusPath, 'utf8')).connectedClients).toBe(1)
})

test("an invalid event is logged and dropped; the same source's next valid event is delivered", async () => {
  writeSource('a.ts', emitter('a'))
  const config = configFor()
  start(config)
  await waitFor(() => probe.ctxs.a !== undefined, 5000, 'a started')
  const { frames, raw } = await client(config)

  const ctx = probe.ctxs.a as SourceContext
  expect(() => ctx.emit({ content: 'bad', meta: { 'chat-id': '1' } })).not.toThrow()
  ctx.emit({ meta: { sender: 'dev' }, content: 'good' })
  await waitFor(() => events(frames).length === 1, 5000, 'the valid event')
  expect(logs).toContain(
    '[daemon] dropping invalid event from a: Error: invalid channel meta key "chat-id": must match /^[A-Za-z0-9_]+$/',
  )
  // The wire's historical event bytes: keys in the order type, source, content, meta.
  expect(Buffer.concat(raw).toString()).toEndWith(
    '{"type":"event","source":"a","content":"good","meta":{"sender":"dev"}}\n',
  )
})

describe('the status file', () => {
  interface Row {
    name: string
    lastEmitAt: string | null
  }
  const status = (config: Config) => JSON.parse(readFileSync(config.statusPath, 'utf8'))
  const row = (config: Config, name: string): Row | undefined =>
    status(config).sources.find((r: Row) => r.name === name)

  test('with zero clients: pid, startedAt, connectedClients 0, and each loaded source with lastEmitAt null before an emit', async () => {
    writeSource('a.ts', emitter('a'))
    const config = configFor()
    start(config)
    await waitFor(() => existsSync(config.statusPath) && row(config, 'a') !== undefined, 5000, 'a in the status')
    const snapshot = status(config)
    expect(snapshot.pid).toBe(process.pid)
    expect(new Date(snapshot.startedAt).toISOString()).toBe(snapshot.startedAt)
    expect(snapshot.connectedClients).toBe(0)
    expect(snapshot.sources).toEqual([
      {
        name: 'a',
        description: 'daemon.test fixture',
        file: 'a.ts',
        defaultSubscribed: true,
        lastEmitAt: null,
        lastError: null,
      },
    ])
  })

  test("a malformed row in the previous status file costs only itself: a valid row's lastError is still seeded", async () => {
    writeSource('a.ts', emitter('a'))
    const config = configFor()
    const lastError = { at: '2026-09-29T00:00:00.000Z', message: 'boom' }
    mkdirSync(config.runDir, { recursive: true })
    writeFileSync(config.statusPath, JSON.stringify({ sources: [{ file: 42 }, { file: 'a.ts', lastError }] }))
    start(config)
    await waitFor(() => row(config, 'a') !== undefined, 5000, 'a in the status')
    expect(status(config).sources[0].lastError).toEqual(lastError)
  })

  test("a crash is recorded on its file's row even over a malformed old lastError; other rows round-trip", () => {
    const path = join(tmp, 'daemon.status.json')
    const other = { file: 42, lastError: 'kept as written' }
    writeFileSync(path, JSON.stringify({ pid: 1, sources: [other, { file: 'a.ts', name: 'a', lastError: 'garbage' }] }))
    recordLastError(path, 'a.ts', 'boom')
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.pid).toBe(1)
    expect(written.sources[0]).toEqual(other)
    expect(written.sources[1]).toMatchObject({ file: 'a.ts', name: 'a', lastError: { message: 'boom' } })
  })

  test('an empty source list is an empty sources array', async () => {
    const config = configFor()
    start(config)
    await listening(config)
    expect(status(config).sources).toEqual([])
  })

  test('lastEmitAt is keyed by source name; an emitted name with no loaded row is ignored', async () => {
    writeSource('a.ts', emitter('a'))
    writeSource('b.ts', emitter('b'))
    writeSource('gone.ts', emitter('gone'))
    const config = configFor()
    start(config)
    await listening(config)
    await waitFor(() => ['a', 'b', 'gone'].every(n => row(config, n) !== undefined), 5000, 'all three listed')

    probe.ctxs.gone?.emit({ content: 'before removal' })
    rmSync(join(tmp, 'src', 'gone.ts'))
    await waitFor(() => row(config, 'gone') === undefined, 5000, 'gone retired')
    probe.ctxs.b?.emit({ content: 'first' })
    expect(row(config, 'a')?.lastEmitAt).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 5)) // distinct timestamps
    probe.ctxs.a?.emit({ content: 'second' })

    const a = row(config, 'a')?.lastEmitAt as string
    const b = row(config, 'b')?.lastEmitAt as string
    expect(new Date(b).toISOString()).toBe(b)
    expect(a > b).toBe(true)
    const names: string[] = status(config).sources.map((r: Row) => r.name)
    expect(names.sort()).toEqual(['a', 'b'])
  })
})

describe('the idle rule', () => {
  const IDLE_MS = 150
  const IDLE_LINE = `[daemon] shutting down (no clients connected for ${IDLE_MS}ms)`
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  function settledFlag(daemon: Promise<unknown>): () => boolean {
    let settled = false
    void daemon.finally(() => {
      settled = true
    })
    return () => settled
  }

  test('with no client, the daemon stops itself after a full idle window', async () => {
    const config = configFor({ DAEMON_IDLE_SHUTDOWN_MS: String(IDLE_MS) })
    const startedAt = Date.now()
    expect(await start(config).daemon).toBe('stopped')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(IDLE_MS - 5)
    expect(logs).toContain(IDLE_LINE)
    expect(existsSync(config.pidPath)).toBe(false)
  })

  test('a connection cancels the countdown for as long as it lasts; the last disconnect re-arms a fresh window', async () => {
    const config = configFor({ DAEMON_IDLE_SHUTDOWN_MS: String(IDLE_MS) })
    const { daemon } = start(config)
    const settled = settledFlag(daemon)
    await listening(config)
    const { socket } = await client(config)
    await sleep(3 * IDLE_MS) // three windows with a client connected
    expect(settled()).toBe(false)

    const disconnectedAt = Date.now()
    socket.destroy()
    expect(await daemon).toBe('stopped')
    expect(Date.now() - disconnectedAt).toBeGreaterThanOrEqual(IDLE_MS - 5) // a whole new window
    expect(logs).toContain(IDLE_LINE)
  })

  test('activity at zero clients does not postpone the idle stop', async () => {
    // A source emitting every 20 ms rewrites the status file each time; only a client-count change touches the window.
    writeSource(
      'ticker.ts',
      `{
  name: 'ticker',
  description: 'daemon.test fixture',
  start(ctx) {
    const id = setInterval(() => ctx.emit({ content: 'tick' }), 20)
    return () => clearInterval(id)
  },
}`,
    )
    const config = configFor({ DAEMON_IDLE_SHUTDOWN_MS: String(IDLE_MS) })
    expect(await start(config).daemon).toBe('stopped')
    expect(logs.some(l => l.startsWith('[daemon] event from ticker'))).toBe(true)
    expect(logs).toContain(IDLE_LINE)
  })

  test('connect/disconnect churn ends with exactly one stop', async () => {
    writeSource('recorder.ts', RECORDER)
    const config = configFor({ DAEMON_IDLE_SHUTDOWN_MS: String(IDLE_MS) })
    const { daemon } = start(config)
    await waitFor(() => probe.ctx !== undefined, 5000, 'recorder started')
    for (let i = 0; i < 5; i++) (await client(config)).socket.destroy()
    expect(await daemon).toBe('stopped')
    await sleep(2 * IDLE_MS) // past any second window
    expect(probe.stops).toBe(1)
    expect(logs.filter(l => l.includes('shutting down'))).toEqual([IDLE_LINE])
  })
})

describe('the stalled-client sweep', () => {
  const SWEEP_MS = 200
  const EVENT = 'x'.repeat(4096)
  const STALLED = 'disconnecting a client whose write buffer exceeded 65536 bytes (stalled consumer)'

  // 4 KiB every 5 ms once the test sets p.flood; the context is handed over for a burst.
  const FLOOD = `{
  name: 'flood',
  description: 'daemon.test fixture',
  start(ctx) {
    p.ctx = ctx
    const id = setInterval(() => { if (p.flood) ctx.emit({ content: ${JSON.stringify(EVENT)} }) }, 5)
    return () => clearInterval(id)
  },
}`

  function sweepConfig(): Config {
    return configFor({ MAX_CLIENT_BUFFER_BYTES: '65536', BACKPRESSURE_CHECK_INTERVAL_MS: String(SWEEP_MS) })
  }

  function closed(socket: Socket): () => boolean {
    let isClosed = false
    socket.once('close', () => {
      isClosed = true
    })
    return () => isClosed
  }

  test('a paused client is eventually destroyed; a reading client and a paused client that muted the source stay connected', async () => {
    writeSource('flood.ts', FLOOD)
    const config = sweepConfig()
    start(config)
    await listening(config)
    await waitFor(() => probe.ctx !== undefined, 5000, 'flood started')

    const muted = await client(config)
    muted.socket.write(subscriptions('muted', [], ['flood']))
    await waitFor(() => logs.some(l => l.includes('session muted subscriptions')), 5000, 'the mute applied')
    muted.socket.pause()
    const reading = await client(config)
    const stalled = await client(config)
    stalled.socket.pause()
    const readingClosed = closed(reading.socket)
    const stalledClosed = closed(stalled.socket)

    probe.flood = true
    /*
     * Socket and peer buffers absorb traffic first, so no deadline is counted
     * from connection: the stalled client only has to be destroyed eventually.
     * A paused socket cannot see its own EOF, so it resumes once the daemon
     * has logged the disconnect and must then observe its close.
     */
    await waitFor(() => logs.includes(`[daemon] ${STALLED}`), 10_000, 'the stall logged')
    stalled.socket.resume()
    await waitFor(stalledClosed, 5000, 'the stalled client closed')
    const readBefore = reading.frames.length
    // Three more sweeps: nothing else is over the limit, and the other two are still counted as connected.
    await new Promise(resolve => setTimeout(resolve, 3 * SWEEP_MS + 100))
    expect(logs.filter(l => l.includes('disconnecting a client'))).toHaveLength(1)
    expect(JSON.parse(readFileSync(config.statusPath, 'utf8')).connectedClients).toBe(2)
    expect(readingClosed()).toBe(false)
    expect(reading.frames.length).toBeGreaterThan(readBefore)
  }, 20_000)

  test('a single synchronous 128 KiB burst does not disconnect a reading client', async () => {
    writeSource('flood.ts', FLOOD)
    const config = sweepConfig()
    start(config)
    await listening(config)
    await waitFor(() => probe.ctx !== undefined, 5000, 'flood started')
    const reading = await client(config)
    const readingClosed = closed(reading.socket)

    for (let i = 0; i < 32; i++) probe.ctx?.emit({ content: EVENT })
    await waitFor(() => reading.frames.filter(f => f.type === 'event').length === 32, 5000, 'the whole burst read')
    await new Promise(resolve => setTimeout(resolve, 3 * SWEEP_MS + 100)) // three sweeps after the burst
    expect(readingClosed()).toBe(false)
    expect(logs.filter(l => l.includes('disconnecting a client'))).toEqual([])
  })
})
