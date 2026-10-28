/*
 * Pins the filedrop builtin end to end: a file dropped into the watched
 * directory arrives as one notification with its contents and filename, and a
 * dotfile produces none.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ProjectSession, projectFixture, type ReceivedEvent, seed, waitFor } from './helpers.ts'

const project = projectFixture({
  sources: { 'webhook.ts': seed('webhook'), 'cron.ts': seed('cron'), 'filedrop.ts': seed('filedrop') },
})

let session: ProjectSession
let received: ReceivedEvent[]

beforeAll(async () => {
  session = project.session()
  received = session.notifications
  await session.connect()
  await session.ready({ health: true })
}, 20_000)

describe('filedrop source: single file', () => {
  test('a file dropped into FILEDROP_DIR arrives as a notification', async () => {
    writeFileSync(join(project.paths.dropboxDir, 'note.txt'), 'hello from a dropped file')

    await waitFor(() => received.length >= 1, 5000, 'first notification to arrive')

    expect(received[0]?.content).toBe('hello from a dropped file')
    expect(received[0]?.meta?.filename).toBe('note.txt')
    expect(received[0]?.meta?.origin).toBe('filedrop')
  })

  test('a dotfile dropped into FILEDROP_DIR produces no notification', async () => {
    const before = received.length
    writeFileSync(join(project.paths.dropboxDir, '.hidden'), 'should be ignored')

    // Give fs.watch + the 150ms debounce a real chance to (wrongly) fire.
    await new Promise(resolve => setTimeout(resolve, 500))

    expect(received).toHaveLength(before)
  })
})
