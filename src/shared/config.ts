import { join, resolve } from 'node:path'

/** A process-environment snapshot: `process.env` in production, a literal in tests. */
export type Env = Readonly<Record<string, string | undefined>>

/** Every run-dir artifact, derived from one directory. File names are an operational contract. */
export interface RunPaths {
  readonly runDir: string
  /** `<runDir>/daemon.sock`, checked against the 103-byte `sun_path` limit. */
  readonly socketPath: string
  /** `<runDir>/daemon.pid`, written after listen ("was listening"). */
  readonly pidPath: string
  /** `<runDir>/daemon.lock`, the startup lock-instance directory. */
  readonly lockPath: string
  /** `<runDir>/daemon.status.json`, the external watchdog snapshot. */
  readonly statusPath: string
  /** `<runDir>/daemon.log` (rotated to `daemon.log.old`). */
  readonly logPath: string
}

/** One validated snapshot of every framework knob, resolved from `(env, cwd)`. */
export interface Config extends RunPaths {
  /** AUTO_CHANNELS_ROOT, default `<cwd>/.channels` (replaces the directory, never appends). */
  readonly root: string
  /** SOURCES_DIR, default `<root>/sources`. */
  readonly sourcesDir: string
  /** DAEMON_IDLE_SHUTDOWN_MS, default 60_000. */
  readonly idleShutdownMs: number
  /** MAX_CLIENT_BUFFER_BYTES, default 4_194_304. */
  readonly maxClientBufferBytes: number
  /** BACKPRESSURE_CHECK_INTERVAL_MS, default 2_000. */
  readonly backpressureCheckMs: number
}

/*
 * Unix socket paths have a hard OS cap (sun_path: ~104 bytes on macOS, 108 on
 * Linux), and exceeding it surfaces only as a bare "Failed to listen" with no
 * mention of length — so check up front and name both the cause and the fix.
 */
const MAX_SOCKET_PATH_BYTES = 103

/**
 * A numeric knob: the fallback when unset, else a positive integer or a throw.
 * NaN would silently misconfigure its reader (`setInterval(fn, NaN)` fires every 1 ms).
 */
export function readPositiveInt(name: string, fallback: number, env: Env = process.env): number {
  const raw = env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`)
  }
  return parsed
}

/**
 * A path knob: the fallback (as given) when unset, else the trimmed value
 * resolved against `cwd`. An explicitly empty value throws.
 */
export function readPath(name: string, fallback: string, env: Env = process.env, cwd: string = process.cwd()): string {
  const raw = env[name]
  if (raw === undefined) return fallback
  const trimmed = raw.trim()
  if (trimmed === '') {
    throw new Error(`${name} must not be empty, got "${raw}"`)
  }
  /*
   * Resolved to absolute: left relative, one value means different things to
   * fs calls (cwd) and dynamic import() (the importing module's directory) —
   * a relative SOURCES_DIR listed fine and then failed to load every file.
   */
  return resolve(cwd, trimmed)
}

/**
 * The channels root: AUTO_CHANNELS_ROOT (resolved against `cwd`), default `<cwd>/.channels`.
 * The override replaces the `.channels` directory itself, not its parent, so `.` gives a flat layout.
 */
export function resolveRoot(env: Env, cwd: string): string {
  return readPath('AUTO_CHANNELS_ROOT', join(cwd, '.channels'), env, cwd)
}

/** Throws the over-long socket error (naming CHANNEL_RUN_DIR) when socketPath exceeds 103 bytes. */
export function runPaths(runDir: string): RunPaths {
  const socketPath = join(runDir, 'daemon.sock')
  const byteLength = Buffer.byteLength(socketPath, 'utf8')
  if (byteLength > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `socket path is ${byteLength} bytes, over the ~${MAX_SOCKET_PATH_BYTES}-byte OS limit for Unix domain sockets: ` +
        `"${socketPath}". Your project directory is nested too deeply for the default .run/ location -- ` +
        'set CHANNEL_RUN_DIR to a short path instead, e.g. CHANNEL_RUN_DIR=/tmp/my-project-channel',
    )
  }
  return {
    runDir,
    socketPath,
    pidPath: join(runDir, 'daemon.pid'),
    lockPath: join(runDir, 'daemon.lock'),
    statusPath: join(runDir, 'daemon.status.json'),
    logPath: join(runDir, 'daemon.log'),
  }
}

/**
 * Pure: reads only its arguments. runDir = CHANNEL_RUN_DIR or `<root>/run`; sourcesDir = SOURCES_DIR or
 * `<root>/sources`. Validation order: root → runDir → socket length → sourcesDir → integers; the first failure throws.
 */
export function resolveConfig(env: Env, cwd: string): Config {
  const root = resolveRoot(env, cwd)
  const paths = runPaths(readPath('CHANNEL_RUN_DIR', join(root, 'run'), env, cwd))
  return {
    ...paths,
    root,
    sourcesDir: readPath('SOURCES_DIR', join(root, 'sources'), env, cwd),
    idleShutdownMs: readPositiveInt('DAEMON_IDLE_SHUTDOWN_MS', 60_000, env),
    maxClientBufferBytes: readPositiveInt('MAX_CLIENT_BUFFER_BYTES', 4 * 1024 * 1024, env),
    backpressureCheckMs: readPositiveInt('BACKPRESSURE_CHECK_INTERVAL_MS', 2000, env),
  }
}
