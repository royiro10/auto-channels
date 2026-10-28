/*
 * Direct tests for the startup lock (A2: a lock instance is a directory
 * holding `owner` = <pid>-<token>, renamed into place; a dead owner's
 * instance is stolen by exactly one contender via a `steal-<owner>` marker).
 * The multi-process case is the proof that matters: 8 processes recovering
 * one stale lock after a SIGKILL must yield exactly one daemon, reachable on
 * daemon.sock. e2e-15 covers the cold-start half
 * through two real adapter processes.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { acquireStartupLock, releaseStartupLock } from '../../src/daemon/startupLock.ts'

const LOCK_MODULE = join(import.meta.dir, '..', '..', 'src', 'daemon', 'startupLock.ts')

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function paths() {
  dir = mkdtempSync(join(tmpdir(), 'startup-lock-test-'))
  const lockPath = join(dir, 'daemon.lock')
  return { lockPath, ownerPath: join(lockPath, 'owner') }
}

function plantLock(lockPath: string, owner?: string): void {
  mkdirSync(lockPath)
  if (owner !== undefined) writeFileSync(join(lockPath, 'owner'), owner)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// The pid of a reaped child: dead, and re-checked as dead before each use.
async function deadPid(): Promise<number> {
  const child = Bun.spawn(['true'])
  await child.exited
  expect(isAlive(child.pid)).toBe(false)
  return child.pid
}

describe('acquireStartupLock', () => {
  test('acquires an uncontested lock immediately', async () => {
    const { lockPath, ownerPath } = paths()
    expect(await acquireStartupLock(lockPath)).toBe('acquired')
    expect(existsSync(ownerPath)).toBe(true)
  })

  test('exactly one of two concurrent cold-starts acquires', async () => {
    // Same process ⇒ same token and a live pid, so the second call sees a live owner.
    const { lockPath, ownerPath } = paths()
    const results = await Promise.all([acquireStartupLock(lockPath), acquireStartupLock(lockPath)])
    expect(results.filter(r => r === 'acquired')).toHaveLength(1)
    expect(results.filter(r => r === 'already-running')).toHaveLength(1)
    expect(existsSync(ownerPath)).toBe(true)
  })

  test('reports already-running while a live owner holds the lock', async () => {
    const { lockPath, ownerPath } = paths()
    const owner = `${process.pid}-foreign`
    plantLock(lockPath, owner)
    expect(await acquireStartupLock(lockPath)).toBe('already-running')
    expect(readFileSync(ownerPath, 'utf8')).toBe(owner)
  })

  test('recovers a lock whose owner pid is dead', async () => {
    const { lockPath, ownerPath } = paths()
    const stale = `${await deadPid()}-crashed`
    plantLock(lockPath, stale)
    expect(await acquireStartupLock(lockPath)).toBe('acquired')
    const owner = readFileSync(ownerPath, 'utf8')
    expect(owner).not.toBe(stale)
    expect(owner.startsWith(`${process.pid}-`)).toBe(true)
  })

  test('recovers a legacy empty-directory lock (the pre-A2 format)', async () => {
    const { lockPath, ownerPath } = paths()
    plantLock(lockPath)
    expect(await acquireStartupLock(lockPath)).toBe('acquired')
    expect(readFileSync(ownerPath, 'utf8').startsWith(`${process.pid}-`)).toBe(true)
  })
})

describe('releaseStartupLock', () => {
  test('acquire then release removes the lock', async () => {
    const { lockPath } = paths()
    await acquireStartupLock(lockPath)
    releaseStartupLock(lockPath)
    expect(existsSync(lockPath)).toBe(false)
  })

  test('leaves a foreign-token or ownerless lock untouched', () => {
    const { lockPath, ownerPath } = paths()
    plantLock(lockPath, `${process.pid}-foreign`)
    releaseStartupLock(lockPath)
    expect(readFileSync(ownerPath, 'utf8')).toBe(`${process.pid}-foreign`)
    rmSync(lockPath, { recursive: true })
    plantLock(lockPath)
    releaseStartupLock(lockPath)
    expect(existsSync(lockPath)).toBe(true)
  })

  test('is a no-op when the lock does not exist', () => {
    const { lockPath } = paths()
    expect(() => releaseStartupLock(lockPath)).not.toThrow()
  })
})

/*
 * Each child waits for one shared release instant, then does what the
 * daemon does: acquire, (slow mode: 200 ms later) rmSync the stale socket
 * and bind it. At T0+1300 ms every bound child connects and checks the
 * answering pid is its own; all stay up until T0+1600 so no exit unbinds a
 * path another child is still checking.
 */
const CHILD = `
import { rmSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { acquireStartupLock } from ${JSON.stringify(LOCK_MODULE)}
const [lockPath, sockPath, t0, mode] = process.argv.slice(2)
const release = Number(t0)
const sleepUntil = at => new Promise(resolve => setTimeout(resolve, Math.max(0, at - Date.now())))
await sleepUntil(release - 3)
while (Date.now() < release) {}
if ((await acquireStartupLock(lockPath)) !== 'acquired') process.exit(0)
console.log('acquired')
if (mode === 'slow') await sleepUntil(Date.now() + 200)
rmSync(sockPath, { force: true })
const server = createServer(socket => socket.end(String(process.pid)))
const bound = await new Promise(resolve => {
  server.once('error', () => resolve(false))
  server.listen(sockPath, () => resolve(true))
})
await sleepUntil(release + 1300)
const answer = !bound ? '' : await new Promise(resolve => {
  let data = ''
  const socket = createConnection(sockPath)
  socket.on('data', chunk => { data += chunk })
  socket.on('end', () => resolve(data))
  socket.on('error', () => resolve(''))
})
console.log(answer === String(process.pid) ? 'reachable' : 'unreachable')
await sleepUntil(release + 1600)
process.exit(0)
`

describe('8 processes recovering one stale lock', () => {
  test('exactly one acquirer per round and no bound-but-unreachable daemon (3 sync + 2 slow rounds)', async () => {
    const root = dirname(paths().lockPath)
    const childPath = join(root, 'child.mjs')
    writeFileSync(childPath, CHILD)

    // A stale daemon.sock, as a SIGKILLed daemon leaves it: connecting to it fails.
    const staleSock = join(root, 'stale.sock')
    const listener = Bun.spawn(
      [
        process.execPath,
        '-e',
        `require('node:net').createServer().listen(${JSON.stringify(staleSock)}, () => console.log('up'))`,
      ],
      { stdout: 'pipe' },
    )
    await listener.stdout.getReader().read()
    listener.kill('SIGKILL')
    await listener.exited

    for (const mode of ['sync', 'sync', 'sync', 'slow', 'slow']) {
      const round = mkdtempSync(join(root, 'round-'))
      const roundLock = join(round, 'daemon.lock')
      const sockPath = join(round, 'daemon.sock')
      plantLock(roundLock, `${await deadPid()}-crashed`)
      linkSync(staleSock, sockPath)
      const t0 = Date.now() + 1000
      const children = Array.from({ length: 8 }, () =>
        Bun.spawn([process.execPath, childPath, roundLock, sockPath, String(t0), mode], { stdout: 'pipe' }),
      )
      const lines = (await Promise.all(children.map(child => new Response(child.stdout).text()))).join('').split('\n')
      await Promise.all(children.map(child => child.exited))
      const count = (word: string) => lines.filter(line => line === word).length
      expect({
        mode,
        acquired: count('acquired'),
        reachable: count('reachable'),
        unreachable: count('unreachable'),
      }).toEqual({ mode, acquired: 1, reachable: 1, unreachable: 0 })
    }
  }, 60_000)
})
