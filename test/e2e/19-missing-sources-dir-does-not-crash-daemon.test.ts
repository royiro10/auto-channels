/*
 * Pins that a missing sources directory is created at startup instead of
 * crashing the daemon, so a fresh consumer's first run works.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type ProjectSession, projectFixture, waitFor } from './helpers.ts'

const project = projectFixture()

let session: ProjectSession
// Deliberately does not exist and is never created before starting the daemon.
let missingSourcesDir: string

beforeAll(async () => {
  missingSourcesDir = join(project.root, 'not-yet')
  session = project.session({ env: { SOURCES_DIR: missingSourcesDir } })
  await session.connect()
}, 20_000)

describe('a missing SOURCES_DIR does not crash the daemon on startup', () => {
  test('the daemon starts, the adapter connects, and the directory is auto-created', async () => {
    await waitFor(
      () => session.connectCount >= 1,
      10_000,
      'adapter connected to daemon despite no sources/ directory existing yet',
    )
    expect(existsSync(missingSourcesDir)).toBe(true)
  })
})
