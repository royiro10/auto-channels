/*
 * Pins the project fixture's own contract: isolation, owned cleanup and
 * daemon-generation tracking. Each fixture lives in its own describe block so
 * its afterAll has run by the time a later block inspects what it left behind.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { projectFixture, READY_TIMEOUT_MS, waitFor } from './helpers.ts'

const PORTS_DIR = '/tmp/auto-channels-test-ports'
const LOGS_DIR = '/tmp/auto-channels-test-logs'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const left = { root: '', port: 0, daemonPid: 0, adapterPid: 0, brokenRoot: '', respawningRoot: '' }

describe('two fixtures', () => {
  const a = projectFixture()
  const b = projectFixture()

  test('get distinct roots and ports, each root short and under /tmp', () => {
    expect(a.root).not.toBe(b.root)
    expect(a.port).not.toBe(b.port)
    expect(a.root).toMatch(/^(\/private)?\/tmp\/ac-/)
    expect(existsSync(join(PORTS_DIR, String(a.port)))).toBe(true)
  })
})

describe('a fixture with a daemon, a direct adapter and a session', () => {
  const project = projectFixture()

  test('killDaemon waits for exit, and the respawned daemon has a new pid', async () => {
    const session = project.session()
    await session.connect()
    await session.ready()
    const before = session.connectCount
    const killed = await project.killDaemon()
    expect(isAlive(killed)).toBe(false)
    await waitFor(() => session.connectCount > before, READY_TIMEOUT_MS, 'reconnect to a respawned daemon')
    const respawned = project.daemonPid()
    expect(respawned).toBeDefined()
    expect(respawned).not.toBe(killed)
    left.daemonPid = respawned ?? 0
  }, 30_000)

  test('a spawnAdapter() child is left running for cleanup to reap', async () => {
    const proc = project.spawnAdapter()
    left.adapterPid = proc.pid
    left.root = project.root
    left.port = project.port
    expect(isAlive(proc.pid)).toBe(true)
  })
})

describe('a session whose adapter exits during setup', () => {
  const project = projectFixture()

  test('fails to connect, and cleanup still runs', async () => {
    left.brokenRoot = project.root
    await Bun.write(join(project.root, 'exits.ts'), 'process.exit(3)\n')
    const session = project.session({ entry: './exits.ts' })
    await expect(session.connect()).rejects.toThrow()
  })
})

describe('a session whose adapter is mid-respawn when cleanup starts', () => {
  const project = projectFixture()

  test('leaves a daemon generation starting that has no pidfile yet', async () => {
    const session = project.session()
    await session.connect()
    await session.ready()
    await project.killDaemon()
    const spawning = '[adapter] daemon not reachable, spawning it'
    await waitFor(
      () => session.stderr.lastIndexOf(spawning) > session.stderr.lastIndexOf('[adapter] connected to daemon'),
      READY_TIMEOUT_MS,
      'the adapter to start spawning a new daemon',
    )
    left.respawningRoot = project.root
  }, 30_000)
})

describe('after cleanup', () => {
  test('the daemon, the direct adapter, the root and the lease are all gone', () => {
    expect(isAlive(left.daemonPid)).toBe(false)
    expect(isAlive(left.adapterPid)).toBe(false)
    expect(existsSync(left.root)).toBe(false)
    expect(existsSync(join(PORTS_DIR, String(left.port)))).toBe(false)
  })

  test('the daemon log and each session stderr were copied out first', () => {
    const logs = readdirSync(join(LOGS_DIR, left.root.split('/').pop() ?? ''))
    expect(logs).toContain('daemon.log')
    expect(logs).toContain('session-0-e2e-test-client.stderr.log')
  })

  test('the broken-session fixture was cleaned up too', () => {
    expect(existsSync(left.brokenRoot)).toBe(false)
  })

  test('a daemon spawned just before cleanup was stopped too, so it cannot recreate the root', async () => {
    /*
     * A leaked daemon recreates <root>/.channels/run when it starts
     * listening, a few hundred ms after its spawn. That spawn preceded the
     * whole cleanup, so 2 s after cleanup is well past it.
     */
    await new Promise(resolve => setTimeout(resolve, 2000))
    expect(existsSync(left.respawningRoot)).toBe(false)
  })
})
