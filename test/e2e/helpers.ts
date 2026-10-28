/*
 * The shared vocabulary of this e2e suite, so there's exactly one place to
 * fix when a contract changes: ChannelNotification (the wire schema),
 * waitFor and the real-signal synchronizers, and projectFixture (one
 * isolated, auto-cleaning consumer project per call; see the README).
 */
import { afterAll, beforeAll } from 'bun:test'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { waitFor } from 'auto-channels/shared/testing.ts'
import { z } from 'zod'
import { type RunPaths, runPaths } from '../../src/shared/config.ts'

const REPO_ROOT = new URL('../..', import.meta.url).pathname

/** The default budget for every fixture readiness wait. */
export const READY_TIMEOUT_MS = 15_000
/** The budget for each fixture cleanup wait before it escalates or fails. */
export const CLEANUP_TIMEOUT_MS = 5_000

export { waitFor }

export const ChannelNotification = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({
    content: z.string(),
    meta: z.record(z.string(), z.string()).optional(),
  }),
})

export type ReceivedEvent = z.infer<typeof ChannelNotification>['params']

/*
 * Synchronization on real signals instead of fixed sleeps. A sleep used as a
 * POSITIVE precondition ("after 400ms the source must be stopped") is a bet
 * on machine speed that a loaded CI box eventually loses — the flake pattern
 * this suite was purged of. These wait for the thing itself, however long it
 * takes (bounded by a timeout), and add no delay when it's already true.
 */

interface ToolCaller {
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<unknown>
}

/** The daemon's source registry as this session sees it (names only). */
export async function listSourceNames(client: ToolCaller): Promise<string[]> {
  const result = (await client.callTool({ name: 'autochannels_list_sources', arguments: {} })) as {
    content: Array<{ text?: string }>
  }
  return (JSON.parse(result.content[0]?.text ?? '[]') as Array<{ name: string }>).map(source => source.name)
}

/**
 * Wait until the registry does (`present: true`) or doesn't list `name`.
 * Also a delivery barrier: the daemon sends event and registry frames down
 * one ordered socket and the adapter forwards them in order before answering
 * the tool call, so once a source is seen gone, every event it emitted has
 * already reached this client — a count taken then is final.
 */
export async function waitForSource(client: ToolCaller, name: string, present: boolean, timeoutMs = 10_000) {
  await waitFor(
    async () => (await listSourceNames(client)).includes(name) === present,
    timeoutMs,
    `source "${name}" to be ${present ? 'loaded' : 'unloaded'}`,
  )
}

/*
 * The project fixture: one isolated, auto-cleaning consumer
 * project per call — a random short root under /tmp (socket-path safe), its
 * own leased webhook port, a scrubbed child env, and one cleanup that owns
 * every session, direct adapter and daemon generation it ever saw.
 */

const PORTS_DIR = '/tmp/auto-channels-test-ports'
const LOGS_DIR = '/tmp/auto-channels-test-logs'
const ADAPTER_ENTRY = join(REPO_ROOT, 'src', 'adapter', 'index.ts')
const CONNECTED_LINE = '[adapter] connected to daemon'
const SPAWNING_LINE = '[adapter] daemon not reachable, spawning it'

// Inherited knobs that would redirect a fixture's children into another project.
const SCRUBBED_ENV = [
  'AUTO_CHANNELS_ROOT',
  'CHANNEL_RUN_DIR',
  'SOURCES_DIR',
  'FILEDROP_DIR',
  'WEBHOOK_PORT',
  'CRON_INTERVAL_MS',
  'DAEMON_IDLE_SHUTDOWN_MS',
  'MAX_CLIENT_BUFFER_BYTES',
  'BACKPRESSURE_CHECK_INTERVAL_MS',
  'AGENT_SESSION_ID',
]

/** The text of one shared builtin activation from `test/e2e/fixtures/sources/` (a read-only input). */
export function seed(name: 'webhook' | 'cron' | 'filedrop'): string {
  return readFileSync(join(import.meta.dir, 'fixtures', 'sources', `${name}.ts`), 'utf8')
}

export interface ProjectSession {
  client: Client
  transport: StdioClientTransport
  /** Everything this adapter wrote to stderr so far. */
  readonly stderr: string
  /** `[adapter] connected to daemon` lines so far — one per (re)connect. */
  readonly connectCount: number
  /** Every channel notification's params, in arrival order. */
  notifications: ReceivedEvent[]
  /** The contents of `notifications`. */
  received: string[]
  connect(): Promise<void>
  close(): Promise<void>
  /** Wait for a daemon connection, then optionally for sources to be listed and the webhook's `/health`. */
  ready(options?: { sources?: string[]; health?: boolean; timeoutMs?: number }): Promise<void>
}

export interface Project {
  root: string
  port: number
  paths: RunPaths & { sourcesDir: string; dropboxDir: string }
  session(options?: { name?: string; env?: Record<string, string>; entry?: string }): ProjectSession
  /** A direct adapter subprocess with piped stdin, reaped by cleanup. */
  spawnAdapter(options?: { env?: Record<string, string> }): Bun.Subprocess<'pipe', 'ignore', 'ignore'>
  writeSource(filename: string, code: string): void
  removeSource(filename: string): void
  logCursor(): { since(): string }
  /** The pid in `daemon.pid` right now, if any; every pid seen is owned by cleanup. */
  daemonPid(): number | undefined
  /** Signal the current daemon and resolve with its pid once that process has exited. */
  killDaemon(signal?: NodeJS.Signals): Promise<number>
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  try {
    await waitFor(() => !isAlive(pid), timeoutMs, `pid ${pid} to exit`)
    return true
  } catch {
    return false
  }
}

// SIGTERM, then SIGKILL after CLEANUP_TIMEOUT_MS; throws if the pid still will not die.
async function stopPid(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return // already gone
  }
  if (await waitForExit(pid, CLEANUP_TIMEOUT_MS)) return
  process.kill(pid, 'SIGKILL')
  if (!(await waitForExit(pid, CLEANUP_TIMEOUT_MS))) throw new Error(`pid ${pid} survived SIGKILL`)
}

function portInUse(port: number): boolean {
  try {
    Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response() }).stop(true)
    return false
  } catch (err) {
    if ((err as { code?: string }).code === 'EADDRINUSE') return true
    throw err
  }
}

/*
 * A port is leased with an atomic mkdir under PORTS_DIR, shared by every
 * concurrent `bun test` process; a lease whose owner pid is dead is stale.
 * Only this initial allocation retries a confirmed external collision.
 */
function leasePort(): { port: number; dir: string } {
  mkdirSync(PORTS_DIR, { recursive: true })
  let collisions = 0
  for (;;) {
    const port = 20000 + Math.floor(Math.random() * 10000)
    const dir = join(PORTS_DIR, String(port))
    try {
      mkdirSync(dir)
    } catch (err) {
      if ((err as { code?: string }).code !== 'EEXIST') throw err
      let owner = 0
      try {
        owner = Number(readFileSync(join(dir, 'pid'), 'utf8'))
      } catch {} // being taken or just released: never stale
      if (owner > 0 && !isAlive(owner)) rmSync(dir, { recursive: true, force: true })
      continue
    }
    writeFileSync(join(dir, 'pid'), String(process.pid))
    if (!portInUse(port)) return { port, dir }
    rmSync(dir, { recursive: true, force: true })
    if (++collisions >= 5) throw new Error(`port lease: ${collisions} external collisions in a row`)
  }
}

/**
 * One isolated consumer project for this test file (or describe block): it
 * registers its own beforeAll/afterAll and starts no daemon until a session
 * connects. `root`, `port` and `paths` are set once beforeAll has run.
 */
export function projectFixture(
  options: { sources?: Record<string, string>; env?: Record<string, string>; mode?: 'repo' | 'installed' } = {},
): Project {
  const sessions: Array<{ name: string; session: ProjectSession }> = []
  const adapters: Bun.Subprocess[] = []
  const daemonPids = new Set<number>()
  let lease: { port: number; dir: string } | undefined

  function childEnv(extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !SCRUBBED_ENV.includes(key)) env[key] = value
    }
    return { ...env, WEBHOOK_PORT: String(project.port), ...options.env, ...extra }
  }

  const project: Project = {
    root: '',
    port: 0,
    paths: {
      runDir: '',
      socketPath: '',
      pidPath: '',
      lockPath: '',
      statusPath: '',
      logPath: '',
      sourcesDir: '',
      dropboxDir: '',
    },

    session({ name = 'e2e-test-client', env, entry = ADAPTER_ENTRY } = {}) {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entry],
        cwd: project.root,
        env: childEnv(env),
        stderr: 'pipe',
      })
      const client = new Client({ name, version: '0.0.1' }, { capabilities: {} })
      let stderr = ''
      transport.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      const notifications: ReceivedEvent[] = []
      const received: string[] = []
      client.setNotificationHandler(ChannelNotification, async ({ params }) => {
        notifications.push(params)
        received.push(params.content)
      })
      const session: ProjectSession = {
        client,
        transport,
        notifications,
        received,
        get stderr() {
          return stderr
        },
        get connectCount() {
          return stderr.split('\n').filter(line => line === CONNECTED_LINE).length
        },
        connect: () => client.connect(transport),
        close: () => client.close(),
        async ready({ sources = [], health = false, timeoutMs = READY_TIMEOUT_MS } = {}) {
          await waitFor(() => session.connectCount >= 1, timeoutMs, 'adapter connected to daemon')
          for (const source of sources) await waitForSource(client, source, true, timeoutMs)
          if (!health) return
          await waitFor(
            async () => {
              try {
                return (await fetch(`http://127.0.0.1:${project.port}/health`)).ok
              } catch {
                return false
              }
            },
            timeoutMs,
            'webhook /health',
          )
        },
      }
      sessions.push({ name, session })
      return session
    },

    spawnAdapter({ env } = {}) {
      const proc = Bun.spawn([process.execPath, ADAPTER_ENTRY], {
        cwd: project.root,
        env: childEnv(env),
        stdin: 'pipe',
        stdout: 'ignore',
        stderr: 'ignore',
      })
      adapters.push(proc)
      return proc
    },

    writeSource(filename, code) {
      writeFileSync(join(project.paths.sourcesDir, filename), code)
    },

    removeSource(filename) {
      rmSync(join(project.paths.sourcesDir, filename), { force: true })
    },

    logCursor() {
      const path = project.paths.logPath
      const read = () => (existsSync(path) ? readFileSync(path, 'utf8') : '')
      const start = read().length
      return { since: () => read().slice(start) }
    },

    daemonPid() {
      if (!existsSync(project.paths.pidPath)) return undefined
      const pid = Number(readFileSync(project.paths.pidPath, 'utf8'))
      if (!(pid > 0)) return undefined
      daemonPids.add(pid)
      return pid
    },

    async killDaemon(signal = 'SIGTERM') {
      const pid = project.daemonPid()
      if (pid === undefined) throw new Error('killDaemon: no daemon.pid')
      process.kill(pid, signal)
      await waitFor(() => !isAlive(pid), READY_TIMEOUT_MS, `daemon ${pid} to exit after ${signal}`)
      return pid
    },
  }

  beforeAll(() => {
    // realpath: /tmp is /private/tmp on macOS, and the daemon's own paths are resolved.
    project.root = realpathSync(mkdtempSync('/tmp/ac-'))
    lease = leasePort()
    project.port = lease.port
    const channels = join(project.root, '.channels')
    project.paths = {
      ...runPaths(join(channels, 'run')),
      sourcesDir: join(channels, 'sources'),
      dropboxDir: join(channels, 'dropbox'),
    }
    if (options.mode === 'installed') return
    mkdirSync(project.paths.sourcesDir, { recursive: true })
    mkdirSync(project.paths.dropboxDir, { recursive: true })
    mkdirSync(join(channels, 'node_modules'))
    symlinkSync(REPO_ROOT, join(channels, 'node_modules', 'auto-channels'))
    for (const [filename, code] of Object.entries(options.sources ?? {})) project.writeSource(filename, code)
  })

  /*
   * Registered before any startup, so a partial setup failure still cleans
   * up. Order matters: adapters first (they respawn daemons), then every
   * daemon generation, and only then the paths and the port.
   */
  afterAll(async () => {
    const failures: string[] = []
    const step = async (label: string, run: () => unknown): Promise<void> => {
      try {
        await run()
      } catch (err) {
        failures.push(`${label}: ${String(err)}`)
      }
    }
    const logDir = join(LOGS_DIR, basename(project.root))
    await step('close sessions', () => Promise.all(sessions.map(({ session }) => session.close())))
    await step('stop direct adapters', () => Promise.all(adapters.map(proc => stopPid(proc.pid))))
    await step('stop daemons', async () => {
      if (project.root === '') return
      project.daemonPid()
      await Promise.all([...daemonPids].map(stopPid))
      /*
       * An adapter whose last word was a spawn (e.g. after a test SIGTERMed
       * the daemon) left a generation starting that has no pidfile yet; it
       * would outlive the root, so wait for it to publish its pid and stop it.
       */
      const inFlight = sessions.some(({ session }) => {
        const { stderr } = session
        return stderr.lastIndexOf(SPAWNING_LINE) > stderr.lastIndexOf(CONNECTED_LINE)
      })
      if (!inFlight) return
      const livePid = () => {
        const pid = project.daemonPid()
        return pid !== undefined && isAlive(pid)
      }
      await waitFor(livePid, CLEANUP_TIMEOUT_MS, 'in-flight daemon').catch(() => {}) // it may lose the lock and never publish
      await Promise.all([...daemonPids].map(stopPid))
    })
    await step('copy logs', () => {
      if (project.root === '') return
      mkdirSync(logDir, { recursive: true })
      if (existsSync(project.paths.logPath)) copyFileSync(project.paths.logPath, join(logDir, 'daemon.log'))
      sessions.forEach(({ name, session }, i) => {
        writeFileSync(join(logDir, `session-${i}-${name}.stderr.log`), session.stderr)
      })
    })
    await step('remove root', () => {
      if (project.root !== '') rmSync(project.root, { recursive: true, force: true })
    })
    await step('release port lease', () => {
      if (lease) rmSync(lease.dir, { recursive: true, force: true })
    })
    if (failures.length > 0) throw new Error(`fixture cleanup failed — ${failures.join('; ')} (logs: ${logDir})`)
  }, 6 * CLEANUP_TIMEOUT_MS)

  return project
}
