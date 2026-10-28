/*
 * Pins crash attribution: a source that throws from its own
 * callback (or leaves a rejection unhandled) still crashes the daemon, which
 * respawns, but daemon.log names the file and the status row for that file
 * carries `lastError`, seeded into the respawned daemon. Each fixture crashes
 * once, guarded by a marker file, and only after it registered.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ProjectSession, projectFixture, READY_TIMEOUT_MS, waitFor } from './helpers.ts'

const project = projectFixture()

let session: ProjectSession

function crasher(name: string, crash: string): string {
  return `import { existsSync, writeFileSync } from 'node:fs'
import type { Source } from 'auto-channels/shared/source.ts'
const marker = ${JSON.stringify(join(project.root, `${name}.crashed`))}
const source: Source = {
  name: '${name}',
  description: 'e2e-39 fixture: crashes the daemon once, after it registered',
  start() {
    const id = setTimeout(() => {
      if (existsSync(marker)) return
      writeFileSync(marker, '')
      ${crash}
    }, 500)
    return () => clearTimeout(id)
  },
}
export default source
`
}

function lastError(file: string): { at: string; message: string } | null | undefined {
  try {
    const status = JSON.parse(readFileSync(project.paths.statusPath, 'utf8'))
    return status.sources.find((row: { file: string }) => row.file === file)?.lastError
  } catch {
    return undefined // absent between daemons
  }
}

/** Write the fixture and wait for the attributed crash, the reconnect, a new pid and the recorded lastError. */
async function crashOnce(file: string, name: string, crash: string, message: string): Promise<void> {
  const pid = project.daemonPid()
  const connects = session.connectCount
  const log = project.logCursor()
  project.writeSource(file, crasher(name, crash))

  await waitFor(
    () => log.since().includes(`source ${file} crashed the daemon:`) && log.since().includes(message),
    READY_TIMEOUT_MS,
    `the crash of ${file} attributed in daemon.log`,
  )
  await waitFor(() => session.connectCount > connects, READY_TIMEOUT_MS, 'the adapter to reconnect')
  await waitFor(
    () => {
      const now = project.daemonPid()
      return now !== undefined && now !== pid
    },
    READY_TIMEOUT_MS,
    'a new daemon pid',
  )
  await waitFor(
    () => lastError(file)?.message.includes(message) === true,
    READY_TIMEOUT_MS,
    `lastError on the ${file} row`,
  )
}

beforeAll(async () => {
  session = project.session()
  await session.connect()
  await session.ready()
}, 30_000)

describe('a source that crashes the daemon is named in the log and the status file', () => {
  test('an uncaught throw from a source timer', async () => {
    await crashOnce('crasher.ts', 'crasher', "throw new Error('boom from crasher')", 'boom from crasher')
    expect(new Date(lastError('crasher.ts')?.at as string).toString()).not.toBe('Invalid Date')
  }, 60_000)

  test('an unhandled rejection created in a source', async () => {
    await crashOnce(
      'rejecter.ts',
      'rejecter',
      "void Promise.reject(new Error('boom from rejecter'))",
      'boom from rejecter',
    )
    // The earlier crash's record survives this respawn too: kept until a graceful stop.
    expect(lastError('crasher.ts')?.message).toContain('boom from crasher')
    expect(existsSync(project.paths.pidPath)).toBe(true)
  }, 60_000)
})
