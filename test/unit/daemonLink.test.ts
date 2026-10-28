/*
 * The daemon link at its interface: connectDaemonLink against fake listeners
 * or none, with spawn.cwd set to a directory that does not exist, so every
 * spawn attempt throws instead of starting a real daemon.
 */
import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectDaemonLink, type DaemonLink } from '../../src/adapter/daemonLink.ts'
import { runPaths } from '../../src/shared/config.ts'
import { waitFor } from '../../src/shared/testing.ts'

const NO_CWD = '/nonexistent-auto-channels-daemonLink-test'

let tmp: string
let logs: string[]
let consoleError: ReturnType<typeof spyOn>
const links: DaemonLink[] = []

// Bun 1.3.14's runner fails a file whose first macrotask turn sees a socket connect error, even a handled one.
beforeAll(() => new Promise(resolve => setTimeout(resolve, 0)))

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'daemonLink-test-'))
  logs = []
  consoleError = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  })
})

afterEach(() => {
  for (const link of links.splice(0)) link.close()
  consoleError.mockRestore()
  rmSync(tmp, { recursive: true, force: true })
})

const paths = () => runPaths(join(tmp, 'run'))

function link(): DaemonLink {
  const created = connectDaemonLink({
    paths: paths(),
    spawn: { env: {}, cwd: NO_CWD },
    onConnect() {},
    onFrame() {},
  })
  links.push(created)
  return created
}

const spawnFailures = () => logs.filter(l => l.includes('[adapter] failed to spawn daemon')).length

test('a throwing spawn closes the log fd on every attempt', async () => {
  link()
  await waitFor(() => spawnFailures() >= 1, 5000, 'the first failed spawn')
  const afterFirst = readdirSync('/dev/fd').length
  // The backoff is 1 s then 2 s, so the third attempt fails about 3 s after the first.
  await waitFor(() => spawnFailures() >= 3, 10_000, 'the third failed spawn')
  expect(readdirSync('/dev/fd').length).toBeLessThanOrEqual(afterFirst)
}, 15_000)

/*
 * Log rotation at spawn time (guarded in the link): an oversized
 * log moves to `.old` only when this attempt found nothing listening. The
 * first `failed to spawn` line is the barrier: rotation precedes the spawn.
 */
const MAX_LOG_BYTES = 10 * 1024 * 1024

function withLog(bytes: number | undefined): string {
  const { runDir, logPath } = paths()
  mkdirSync(runDir, { recursive: true })
  if (bytes !== undefined) {
    writeFileSync(logPath, 'small content')
    truncateSync(logPath, bytes)
  }
  return logPath
}

test.each([
  ['absent', undefined, false],
  ['small', 13, false],
  ['exactly 10 MiB', MAX_LOG_BYTES, false],
  ['over 10 MiB, with a missing socket path', MAX_LOG_BYTES + 1, true],
] as const)('with no listener, a log that is %s is rotated only past 10 MiB', async (_label, bytes, rotated) => {
  const logPath = withLog(bytes)
  link()
  await waitFor(() => spawnFailures() >= 1, 5000, 'the first failed spawn')
  expect(existsSync(`${logPath}.old`)).toBe(rotated)
  if (rotated) expect(statSync(`${logPath}.old`).size).toBe(MAX_LOG_BYTES + 1)
  if (bytes === 13) expect(readFileSync(logPath, 'utf8')).toBe('small content')
})

test('an existing .old is replaced', async () => {
  const logPath = withLog(MAX_LOG_BYTES + 1)
  writeFileSync(`${logPath}.old`, 'stale from an earlier rotation')
  link()
  await waitFor(() => spawnFailures() >= 1, 5000, 'the first failed spawn')
  expect(statSync(`${logPath}.old`).size).toBe(MAX_LOG_BYTES + 1)
})

test('a live listener means no rotation, even once its established connection is lost', async () => {
  const logPath = withLog(MAX_LOG_BYTES + 1)
  let connections = 0
  const server = createServer(socket => {
    connections++
    socket.destroy() // the daemon side drops it: the link retries and spawns, but must not rotate
  })
  await new Promise<void>(resolve => server.listen(paths().socketPath, resolve))
  try {
    // Started: Bun 1.2.x surfaces a peer close on a paused (unstarted) socket only once it is resumed.
    link().start()
    await waitFor(() => spawnFailures() >= 1, 5000, 'the spawn after the lost connection')
    expect(connections).toBe(1)
    expect(existsSync(`${logPath}.old`)).toBe(false)
    expect(statSync(logPath).size).toBe(MAX_LOG_BYTES + 1)
  } finally {
    server.close()
  }
})

test('a stale socket file left by a SIGKILLed listener rotates', async () => {
  const logPath = withLog(MAX_LOG_BYTES + 1)
  const { socketPath } = paths()
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `require('node:net').createServer().listen(${JSON.stringify(socketPath)}, () => console.log('listening'))`,
    ],
    { stdout: 'pipe' },
  )
  const reader = child.stdout.getReader()
  let out = ''
  while (!out.includes('listening')) out += new TextDecoder().decode((await reader.read()).value)
  child.kill('SIGKILL')
  await child.exited
  expect(existsSync(socketPath)).toBe(true)

  link()
  await waitFor(() => spawnFailures() >= 1, 5000, 'the first failed spawn')
  // Bun reports either ENOENT or ECONNREFUSED for a stale socket file; both mean nothing is listening.
  expect(statSync(`${logPath}.old`).size).toBe(MAX_LOG_BYTES + 1)
})
