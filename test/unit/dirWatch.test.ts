/*
 * shared/dirWatch.ts exists because fs.watch's per-event filename drops
 * changes: Bun on macOS coalesces a burst into one event naming only the
 * first file. These tests write real files in bursts — on the
 * affected platform, the burst tests fail against a filename-trusting watch.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDirectoryWatch } from '../../src/shared/dirWatch.ts'
import { waitFor } from '../../src/shared/testing.ts'

let dir: string
let watcher: { close(): void } | undefined

afterEach(() => {
  watcher?.close()
  watcher = undefined
  rmSync(dir, { recursive: true, force: true })
})

async function watchFresh(seed: Record<string, string> = {}): Promise<Set<string>> {
  dir = mkdtempSync(join(tmpdir(), 'dirwatch-'))
  for (const [name, content] of Object.entries(seed)) writeFileSync(join(dir, name), content)
  const seen = new Set<string>()
  watcher = startDirectoryWatch(dir, name => seen.add(name))
  return seen
}

describe('startDirectoryWatch', () => {
  test('reports every file of a same-tick burst of creations, not just the first', async () => {
    const seen = await watchFresh()
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) writeFileSync(join(dir, name), name)
    await waitFor(() => seen.size === 4, 3000, 'all four files reported')
    expect([...seen].sort()).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt'])
  })

  test('reports modifications and removals in a burst too', async () => {
    const seen = await watchFresh({ 'keep.txt': 'v1', 'gone.txt': 'x' })
    writeFileSync(join(dir, 'keep.txt'), 'version two')
    rmSync(join(dir, 'gone.txt'))
    await waitFor(() => seen.has('keep.txt') && seen.has('gone.txt'), 3000, 'modify + remove reported')
  })

  test('entries present at start are not reported until they change', async () => {
    /*
     * Seeded immediately before the watch starts, on purpose: macOS delivers
     * a late event for those writes, and reporting it made the source loader
     * reload a just-loaded source for nothing (the e2e-10 flake).
     */
    const seen = await watchFresh({ 'old.txt': 'untouched' })
    writeFileSync(join(dir, 'new.txt'), 'x')
    await waitFor(() => seen.has('new.txt'), 3000, 'new file reported')
    expect(seen.has('old.txt')).toBe(false)
  })

  test('deleting the watched directory reports every entry removed and does not throw; files in a recreated directory are reported', async () => {
    // Unguarded, the rescan threw ENOENT from a timer, which fails this test as an unhandled error.
    const seen = await watchFresh({ 'a.txt': 'a', 'b.txt': 'b' })
    rmSync(dir, { recursive: true })
    await waitFor(() => seen.has('a.txt') && seen.has('b.txt'), 3000, 'both entries reported removed')
    mkdirSync(dir)
    writeFileSync(join(dir, 'c.txt'), 'c')
    await waitFor(() => seen.has('c.txt'), 3000, 'a file in the recreated directory reported')
  })

  test('a watcher error closes the watcher without throwing and the periodic rescan still reports changes', async () => {
    // No platform error is reliably producible here, so capture the real watcher and emit one on it.
    const realWatch = fs.watch
    let fsWatcher: fs.FSWatcher | undefined
    const spy = spyOn(fs, 'watch').mockImplementation(((...args: Parameters<typeof fs.watch>) => {
      fsWatcher = realWatch(...args)
      return fsWatcher
    }) as typeof fs.watch)
    const seen = await watchFresh().finally(() => spy.mockRestore())
    let closed = false
    fsWatcher?.on('close', () => {
      closed = true
    })
    expect(() => fsWatcher?.emit('error', new Error('watcher boom'))).not.toThrow()
    await waitFor(() => closed, 3000, 'the errored watcher to close')
    writeFileSync(join(dir, 'after.txt'), 'x')
    await waitFor(() => seen.has('after.txt'), 3000, 'a change reported by the periodic rescan')
  })
})
