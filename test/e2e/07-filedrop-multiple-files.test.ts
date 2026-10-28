/*
 * Drops three distinct files in quick succession into the filedrop source's
 * watched directory and asserts exactly one notification per file arrives,
 * with the right filename -> content mapping (not just "3 arrived" — the
 * debounce is keyed per-filename, so a bug there could duplicate or drop
 * events for individual files while still passing a coarser count check).
 * Also overwrites one of those files after its first event has landed, to
 * prove the watcher reacts to modifications, not just creation.
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

describe('filedrop source: multiple files', () => {
  test('dropping three files in quick succession emits exactly one notification each, correctly mapped', async () => {
    const files: Record<string, string> = {
      'a.txt': 'content for file a',
      'b.txt': 'content for file b',
      'c.txt': 'content for file c',
    }

    for (const [filename, content] of Object.entries(files)) {
      writeFileSync(join(project.paths.dropboxDir, filename), content)
    }

    // Debounce is 150ms per-filename; give it generous headroom plus fs.watch latency.
    await waitFor(() => received.length >= 3, 8000, 'three filedrop notifications')

    // No extra/duplicate events should show up from the debounce either.
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(received).toHaveLength(3)

    const byFilename = new Map<string, string>()
    for (const event of received) {
      const filename = event.meta?.filename
      expect(filename).toBeDefined()
      byFilename.set(filename as string, event.content)
    }

    expect(byFilename.size).toBe(3)
    for (const [filename, content] of Object.entries(files)) {
      expect(byFilename.get(filename)).toBe(content)
    }

    for (const event of received) {
      expect(event.meta?.origin).toBe('filedrop')
    }
  }, 12_000)

  test('modifying a previously-seen file emits a second, distinct notification with the new content', async () => {
    const newContent = 'content for file a, take two'
    writeFileSync(join(project.paths.dropboxDir, 'a.txt'), newContent)

    await waitFor(
      () => received.filter(event => event.meta?.filename === 'a.txt').length >= 2,
      8000,
      'second notification for a.txt',
    )

    // Still exactly 4 total: the original 3 plus this one modification event.
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(received).toHaveLength(4)

    const aEvents = received.filter(event => event.meta?.filename === 'a.txt')
    expect(aEvents).toHaveLength(2)
    expect(aEvents[0]?.content).toBe('content for file a')
    expect(aEvents[1]?.content).toBe(newContent)
  }, 12_000)
})
