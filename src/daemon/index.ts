/*
 * The persistent per-project daemon, one per run dir, shared by every session.
 * runDaemon owns the run dir until its signal aborts or it goes idle; the
 * import.meta.main entry below maps that to signals and an exit code.
 */
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { basename } from 'node:path'
import { z } from 'zod'
import { type Config, resolveConfig } from '../shared/config.ts'
import { createLogger } from '../shared/log.ts'
import {
  createFrameReader,
  encodeFrame,
  type Intent,
  parseEvent,
  type SourceInfo,
  type SubscriptionsFrame,
  wants,
} from '../shared/protocol.ts'
import type { ChannelEvent } from '../shared/source.ts'
import { type SourceIdentity, type SourceLoader, startSourceLoader } from './sourceLoader.ts'
import { acquireStartupLock, releaseStartupLock } from './startupLock.ts'

const log = createLogger('daemon')

/*
 * Events can be arbitrarily large (a filedrop of a whole file); the per-event
 * log line carries just enough content to identify it.
 */
const LOG_PREVIEW_CHARS = 80

/*
 * `<run>/daemon.status.json`, the external snapshot a watchdog polls (decisions
 * 0013, 0014). Not a heartbeat: a quiet daemon goes long stretches between writes,
 * and a SIGKILLed one leaves a stale file, so pair it with a pid liveness check.
 */
interface DaemonStatus {
  pid: number
  startedAt: string
  connectedClients: number
  sources: Array<SourceInfo & { lastEmitAt: string | null; lastError: LastError | null }>
}

/*
 * The last crash a source file caused, keyed by file because the crash stack names
 * a file. The crash handler writes it into the dead daemon's status file; the
 * respawned daemon seeds from there until a graceful stop removes it.
 */
const LastErrorSchema = z.object({ at: z.string(), message: z.string() })
type LastError = z.infer<typeof LastErrorSchema>

// The fields read back from a status file; everything else round-trips as written.
const StatusFileSchema = z.looseObject({ sources: z.array(z.unknown()) })
// Validated one at a time, so a malformed row costs only itself.
const StatusRowFileSchema = z.looseObject({ file: z.string() })
const StatusRowSchema = StatusRowFileSchema.extend({ lastError: LastErrorSchema.nullish() })
const statusRow = (row: unknown) => StatusRowSchema.safeParse(row).data

// A missing file, a directory (EISDIR), bad JSON or an unexpected shape all mean "no record".
function readStatusFile(path: string): z.infer<typeof StatusFileSchema> | undefined {
  let json: unknown
  try {
    json = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  return StatusFileSchema.safeParse(json).data
}

/**
 * The crash handler's record: set `file`'s row's lastError in the status file. The row is matched by
 * file alone, so a malformed old lastError is overwritten. No row (a source that crashed before it
 * ever registered) or no readable file records nothing: the log line is then the only record.
 */
export function recordLastError(path: string, file: string, message: string): void {
  const status = readStatusFile(path)
  const index = status?.sources.findIndex(value => StatusRowFileSchema.safeParse(value).data?.file === file) ?? -1
  const row = StatusRowFileSchema.safeParse(status?.sources[index]).data
  if (!status || !row) return
  status.sources[index] = { ...row, lastError: { at: new Date().toISOString(), message } }
  writeStatusFile(path, status)
}

/*
 * Best-effort and atomic: a failing side channel must never crash the
 * daemon or block delivery, and a reader must see a whole old or
 * new snapshot — writing in place let it read a truncated file. On
 * failure the temp file goes, non-recursively, so a planted directory stays.
 */
function writeStatusFile(path: string, status: object): void {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(status))
    renameSync(tmp, path)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {}
    log(`failed to write status: ${String(err)}`)
  }
}

/**
 * Own config.runDir as this project's one daemon until `signal` aborts or no client has been connected for
 * config.idleShutdownMs. Resolves 'already-running' (touching nothing but mkdir runDir) if another process
 * owns the lock, 'stopped' after a clean stop (immediately if `signal` is already aborted once the lock is held).
 * Once settled it holds no framework-owned listener, client socket, timer, descriptor or run-dir artifact other
 * than daemon.log. Source-owned work (a non-awaited async stop(), a hung start(), filedrop's pending stability
 * checks) may outlive settlement under the source contract; its late emits reach no client and write no status.
 * Never calls process.exit.
 */
export async function runDaemon(config: Config, signal: AbortSignal): Promise<'already-running' | 'stopped'> {
  mkdirSync(config.runDir, { recursive: true })
  if ((await acquireStartupLock(config.lockPath)) === 'already-running') return 'already-running'
  if (signal.aborted) {
    releaseStartupLock(config.lockPath)
    return 'stopped'
  }

  return new Promise((resolve, reject) => {
    // Each connected adapter and its session's intent; `undefined` until it sends one (see wants).
    const clients = new Map<Socket, Intent | undefined>()
    // Per-source last-emit wall-clock time, for the external status file — not needed for delivery itself.
    const lastEmitAt = new Map<string, string>()
    const lastErrors = new Map(
      readStatusFile(config.statusPath)?.sources.flatMap(value => {
        const row = statusRow(value)
        return row?.lastError ? [[row.file, row.lastError] as const] : []
      }),
    )
    // Captured once, so "up since when" reports this daemon's start, not the most recent status write.
    const startedAt = new Date().toISOString()
    let stopping = false
    let idle: ReturnType<typeof setTimeout> | undefined
    let sweep: ReturnType<typeof setInterval> | undefined
    let loader: SourceLoader | undefined

    const onAbort = () => stop(String(signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })

    /*
     * Written on every state change, undebounced (daemon.log already pays per event).
     * Never after the stop began: a late emit must not re-create the removed file.
     */
    function writeStatus(): void {
      if (stopping) return
      writeStatusFile(config.statusPath, {
        pid: process.pid,
        startedAt,
        connectedClients: clients.size,
        sources: (loader?.list() ?? []).map(row => ({
          ...row,
          lastEmitAt: lastEmitAt.get(row.name) ?? null,
          lastError: lastErrors.get(row.file) ?? null,
        })),
      } satisfies DaemonStatus)
    }

    /*
     * The idle rule: counted here, because a crashed adapter runs no
     * shutdown code. The window is armed at start (the spawning adapter may die before
     * connecting), never reset while armed, and cancelled by a connection.
     */
    function clientsChanged(): void {
      if (clients.size > 0) {
        clearTimeout(idle)
        idle = undefined
      } else if (idle === undefined) {
        idle = setTimeout(() => stop(`no clients connected for ${config.idleShutdownMs}ms`), config.idleShutdownMs)
      }
      writeStatus()
    }

    // Idempotent: 'error' and 'close' both land here, and stop() has already forgotten every client.
    function drop(socket: Socket): void {
      if (!clients.delete(socket)) return
      clientsChanged()
      log(`adapter disconnected (${clients.size} total)`)
    }

    /*
     * Full-state replacement. Unsubscribed first, so a name listed in both ends up
     * subscribed. Ignored if the socket already disconnected.
     */
    function applyIntent(socket: Socket, frame: SubscriptionsFrame): void {
      if (!clients.has(socket)) return
      clients.set(
        socket,
        new Map([
          ...frame.unsubscribed.map(name => [name, false] as const),
          ...frame.subscribed.map(name => [name, true] as const),
        ]),
      )
      log(
        `session ${frame.sessionId} subscriptions: +[${frame.subscribed.join(', ')}] -[${frame.unsubscribed.join(', ')}]`,
      )
    }

    function emit({ name, defaultSubscribed }: SourceIdentity, raw: unknown): void {
      /*
       * Sources are untyped at runtime, and this runs inside a source's own callback,
       * where a throw would crash every source in the process: an invalid event is
       * logged and dropped, never thrown back.
       */
      let event: ChannelEvent
      try {
        event = parseEvent(raw)
      } catch (err) {
        // String() of a ZodError is its message.
        log(`dropping invalid event from ${name}: ${String(err)}`)
        return
      }
      log(`event from ${name}: ${event.content.slice(0, LOG_PREVIEW_CHARS)}`)
      // Key order { type, source, content, meta } is the wire's historical byte layout (daemon.test.ts pins it).
      const frame = encodeFrame({ type: 'event', source: name, content: event.content, meta: event.meta })
      // The emitting instance's own default, even mid-start or retired — never a lookup by name.
      for (const [client, intent] of clients) {
        if (wants(intent, name, defaultSubscribed)) client.write(frame)
      }
      lastEmitAt.set(name, new Date().toISOString()) // after delivery: the status side channel comes second
      writeStatus()
    }

    // Delivery is filtered by intent; a registry push goes to every client, subscriptions notwithstanding.
    function onRegistryChange(sources: SourceInfo[]): void {
      const frame = encodeFrame({ type: 'sources', sources })
      for (const client of clients.keys()) client.write(frame)
      writeStatus()
    }

    /*
     * A hung client (socket open, not reading) would grow the daemon's memory without
     * bound. Checked on a timer, NOT inline after writes: one synchronous emit
     * burst briefly pushes even a healthy client over the limit. 'close' then drops it.
     */
    function sweepStalled(): void {
      for (const client of clients.keys()) {
        if (client.writableLength > config.maxClientBufferBytes) {
          log(
            `disconnecting a client whose write buffer exceeded ${config.maxClientBufferBytes} bytes (stalled consumer)`,
          )
          // Not destroy(): on Bun 1.2.0 it leaks the fd of a socket with a pending write buffer.
          client.resetAndDestroy()
        }
      }
    }

    const server = createServer(socket => {
      clients.set(socket, undefined)
      clientsChanged()
      log(`adapter connected (${clients.size} total)`)

      // The sources frame is always a connection's first: the adapter mirrors it, never requests it.
      socket.write(encodeFrame({ type: 'sources', sources: loader?.list() ?? [] }))

      // Malformed input from a client is logged and ignored, never fatal.
      socket.on(
        'data',
        createFrameReader(
          'adapter',
          frame => applyIntent(socket, frame),
          err => log(`dropping malformed frame from an adapter: ${err}`),
        ),
      )
      socket.on('error', () => drop(socket))
      socket.on('close', () => drop(socket))
    })

    /*
     * The one stop path: an abort, the idle rule, or a startup/socket-server error
     * (which rejects after the same sequence). Runs once and synchronously,
     * in order: sources, timers, clients, server, run-dir artifacts, then the lock.
     */
    function stop(reason: string, err?: unknown): void {
      if (stopping) return
      stopping = true
      log(`shutting down (${reason})`)
      signal.removeEventListener('abort', onAbort)
      loader?.close() // first, so a source's final synchronous emits still reach clients
      clearTimeout(idle)
      clearInterval(sweep)
      const sockets = [...clients.keys()]
      clients.clear() // before destroying, so their 'close' finds nothing to drop
      for (const socket of sockets) socket.destroy()
      try {
        server.close()
      } catch {}
      // Each removal is best-effort, so one failure (e.g. a directory at the status path) can't skip the rest.
      for (const path of [config.socketPath, config.pidPath, config.statusPath]) {
        try {
          rmSync(path, { force: true })
        } catch (err) {
          log(`failed to remove ${path}: ${String(err)}`)
        }
      }
      try {
        releaseStartupLock(config.lockPath)
      } catch (err) {
        log(`failed to release lock: ${String(err)}`)
      }
      err === undefined ? resolve('stopped') : reject(err)
    }

    clientsChanged() // zero clients: arms the idle rule

    try {
      rmSync(config.socketPath, { force: true }) // safe: only the lock holder ever touches the socket path
    } catch (err) {
      stop('startup failed', err) // e.g. a directory at the socket path: release the lock, never leave it held
      return
    }
    server.on('error', err => stop('socket server error', err))
    server.listen(config.socketPath, () => {
      try {
        writeFileSync(config.pidPath, String(process.pid))
        writeStatus() // initial write: sources: [] until the loader's first onRegistryChange fires
        log(`listening on ${config.socketPath} (pid ${process.pid})`)
        sweep = setInterval(sweepStalled, config.backpressureCheckMs)
        loader = startSourceLoader({ dir: config.sourcesDir, emit, onRegistryChange })
      } catch (err) {
        stop('startup failed', err)
      }
    })
  })
}

if (import.meta.main) {
  /*
   * Resolved once, before acquiring anything, so an invalid override fails fast
   * instead of leaving a stale startup lock behind (see shared/config.ts).
   */
  const config = resolveConfig(process.env, process.cwd())
  const controller = new AbortController()
  // The signal name is the abort reason, so the log still reads `shutting down (SIGTERM)`.
  for (const name of ['SIGINT', 'SIGTERM'] as const) process.on(name, () => controller.abort(name))

  /*
   * A source callback's uncaught throw or rejection still crashes the daemon (the adapter
   * respawns it), but attributably: the first stack frame under the realpath'd sources dir
   * names the file. No graceful sequence: the next start's lock steal recovers.
   */
  const onCrash = (err: unknown): never => {
    const stack = err instanceof Error && err.stack ? err.stack : String(err)
    const message = err instanceof Error ? err.message : String(err)
    let base = config.sourcesDir
    try {
      base = realpathSync(base)
    } catch {}
    const prefix = `${base}/`
    const frame = stack.split('\n').find(line => line.includes(prefix))
    const file = frame && basename(frame.slice(frame.indexOf(prefix) + prefix.length).split(/[?:)\s]/)[0] ?? '')
    log(file ? `source ${file} crashed the daemon: ${stack}` : `daemon crashed: ${stack}`)
    if (file) recordLastError(config.statusPath, file, message)
    process.exit(1)
  }
  process.on('uncaughtException', onCrash)
  process.on('unhandledRejection', onCrash)

  try {
    if ((await runDaemon(config, controller.signal)) === 'already-running') {
      log('another daemon is already running, exiting')
    }
    process.exit(0)
  } catch (err) {
    log(`daemon failed: ${String(err)}`)
    process.exit(1)
  }
}
