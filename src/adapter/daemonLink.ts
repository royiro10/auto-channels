import { closeSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import type { Env, RunPaths } from '../shared/config.ts'
import { createLogger } from '../shared/log.ts'
import { type AdapterFrame, createFrameReader, type DaemonFrame, encodeFrame } from '../shared/protocol.ts'

const log = createLogger('adapter')
const DAEMON_ENTRY = join(import.meta.dir, '..', 'daemon', 'index.ts')
const MAX_LOG_BYTES = 10 * 1024 * 1024
const INITIAL_RECONNECT_DELAY_MS = 1000
const MAX_RECONNECT_DELAY_MS = 5000

export interface DaemonLinkOptions {
  paths: Pick<RunPaths, 'runDir' | 'socketPath' | 'logPath'>
  /** The daemon is spawned with exactly these, via process.execPath. */
  spawn: { env: Env; cwd: string }
  /** Once per live connection, after start(), before its first frame. */
  onConnect(): void
  /** In socket order, only after start(). */
  onFrame(frame: DaemonFrame): void
}

export interface DaemonLink {
  /**
   * Begin handing connections to the caller. Before this, the link already connects (spawning if needed)
   * but leaves each connected socket paused, so frames queue and are not lost. Idempotent.
   */
  start(): void
  /** Encoded and written if a started connection is live; otherwise dropped (intent is replayed on connect). */
  send(frame: AdapterFrame): void
  /** No more retries, spawns, timers, or callbacks. Idempotent. */
  close(): void
}

function spawnDaemon({ paths, spawn }: DaemonLinkOptions, rotate: boolean): void {
  log('daemon not reachable, spawning it')
  /*
   * The detached daemon has no terminal: daemon.log is the only place its diagnostics
   * go. An oversized log is moved aside only when the caller saw nothing
   * listening (`rotate`): rename doesn't invalidate an open fd, so rotating under a
   * live daemon redirects all its output into `.old`. A socket file existing
   * is not a listener existing — only a refused or missing connect says nobody listens.
   */
  try {
    mkdirSync(paths.runDir, { recursive: true })
    if (rotate && (statSync(paths.logPath, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_BYTES) {
      renameSync(paths.logPath, `${paths.logPath}.old`)
    }
    const logFd = openSync(paths.logPath, 'a')
    /*
     * The child holds its own copy of the fd; ours must be closed even when the spawn
     * throws. This runs on every failed attempt, so a leak would end in EMFILE.
     */
    try {
      Bun.spawn([process.execPath, DAEMON_ENTRY], {
        cwd: spawn.cwd,
        env: spawn.env,
        stdio: ['ignore', logFd, logFd],
        detached: true,
      }).unref()
    } finally {
      closeSync(logFd)
    }
  } catch (err) {
    log(`failed to spawn daemon: ${String(err)}`)
  }
}

/**
 * Keep a live socket to the daemon, spawning it on every failed attempt, with
 * exponential backoff. Connecting is eager; handing a connection to the caller
 * waits for start(). Frames are decoded here; what they mean is the caller's business.
 */
export function connectDaemonLink(options: DaemonLinkOptions): DaemonLink {
  let started = false
  let closed = false
  /*
   * Link-lifetime, not per-socket: a disconnect of an established connection
   * counts as a fresh outage, so it resets on every successful connect.
   */
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  // Connected but not yet handed over: paused, so its frames queue in the socket.
  let pending: Socket | undefined
  let live: Socket | undefined

  function connectToDaemon(): void {
    if (closed) return
    const socket = connect(options.paths.socketPath)
    // A failed attempt fires both 'error' and 'close': without the guard, two spawns and two reconnect loops.
    let retried = false
    let everConnected = false
    const retry = (err?: NodeJS.ErrnoException): void => {
      if (retried || closed) return
      retried = true
      if (live === socket) live = undefined
      if (pending === socket) pending = undefined
      /*
       * Spawn on EVERY failed attempt, not once per outage, or a daemon that dies again
       * before a reconnect is never respawned; the startup lock makes a redundant
       * spawn a fast no-op. Rotate only if this attempt never connected: a lost established
       * connection may leave a live daemon holding its fd. A daemon mid-startup can still
       * lose its output to `.old` (a documented race).
       */
      spawnDaemon(options, !everConnected && (err?.code === 'ENOENT' || err?.code === 'ECONNREFUSED'))
      timer = setTimeout(connectToDaemon, Math.min(INITIAL_RECONNECT_DELAY_MS * 2 ** attempt, MAX_RECONNECT_DELAY_MS))
      attempt += 1
    }

    socket.on('connect', () => {
      if (closed) {
        socket.destroy()
        return
      }
      attempt = 0
      everConnected = true
      socket.pause()
      if (started) handOver(socket)
      else pending = socket
    })
    socket.on('error', retry)
    socket.on('close', () => retry())
  }

  /*
   * The only place 'data' is attached. The socket was paused explicitly, so
   * adding the listener does not start the flow; live is set before
   * onConnect, so a send from there goes out ahead of any frame.
   */
  function handOver(socket: Socket): void {
    pending = undefined
    live = socket
    // One reader per connection: a torn tail from a dead socket must not prefix the next one's first frame.
    socket.on(
      'data',
      createFrameReader('daemon', options.onFrame, err => log(`dropping malformed frame from daemon: ${err}`)),
    )
    log('connected to daemon')
    options.onConnect()
    socket.resume()
  }

  connectToDaemon()

  return {
    start(): void {
      if (started) return
      started = true
      if (pending && !pending.destroyed) handOver(pending)
    },
    send(frame: AdapterFrame): void {
      if (live && !live.destroyed) live.write(encodeFrame(frame))
    },
    close(): void {
      closed = true
      clearTimeout(timer)
      live?.destroy()
      pending?.destroy()
    },
  }
}
