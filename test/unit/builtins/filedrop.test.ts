/*
 * The filedrop builtin's zero-arg instance and its factory options, using the same mock-context pattern a consumer
 * uses for their own sources:
 * a mock SourceContext instead of a real daemon + adapter + socket. filedrop
 * still does real filesystem I/O (that's the point of testing it), but
 * nothing about Claude Code, MCP, or the wire protocol is involved.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMockContext, startForTest, waitFor } from 'auto-channels/shared/testing.ts'
import { filedrop as filedropFactory } from '../../../src/builtins/index.ts'

const filedrop = filedropFactory()

let stop: (() => void) | undefined
let dir: string | undefined
let outsideDir: string | undefined

afterEach(() => {
  stop?.()
  stop = undefined
  delete process.env.FILEDROP_DIR
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
  if (outsideDir) rmSync(outsideDir, { recursive: true, force: true })
  outsideDir = undefined
})

/*
 * macOS FSEvents has real startup latency: fs.watch() returns synchronously,
 * but a write landing before the underlying event stream has actually
 * started can be dropped entirely -- not delayed, MISSED, so no waitFor
 * timeout rescues it. Rare in isolation, observed once under full-suite
 * load. Giving the watcher a beat before the first write closes that
 * window; every test that writes immediately after startForTest uses this.
 * A timing bet, listed in CONTRIBUTING.md.
 */
async function startWatching(ctx: ReturnType<typeof createMockContext>): Promise<() => void> {
  const stopFn = await startForTest(filedrop, ctx)
  await new Promise(resolve => setTimeout(resolve, 150))
  return stopFn
}

describe('filedrop source', () => {
  test("emits a dropped file's contents with its filename in meta", async () => {
    dir = mkdtempSync(join(tmpdir(), 'filedrop-test-'))
    process.env.FILEDROP_DIR = dir
    const ctx = createMockContext()
    stop = await startWatching(ctx)

    writeFileSync(join(dir, 'note.txt'), 'hello from a test')
    await waitFor(() => ctx.emitted.length >= 1)

    expect(ctx.emitted[0]?.content).toBe('hello from a test')
    expect(ctx.emitted[0]?.meta?.filename).toBe('note.txt')
  })

  test('ignores dotfiles', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filedrop-test-'))
    process.env.FILEDROP_DIR = dir
    const ctx = createMockContext()
    stop = await startWatching(ctx)

    writeFileSync(join(dir, '.hidden'), 'should not emit')
    await new Promise(resolve => setTimeout(resolve, 300))

    expect(ctx.emitted).toHaveLength(0)
  })

  test('rejects an empty FILEDROP_DIR with a clear error instead of a cryptic ENOENT', async () => {
    process.env.FILEDROP_DIR = ''
    await expect(startForTest(filedrop, createMockContext())).rejects.toThrow(/FILEDROP_DIR must not be empty/)
  })

  test('a bad channels root fails at start(), not at import', () => {
    /*
     * A fresh process, so the env is in place before anything is imported: the
     * builtins must import cleanly and resolve the root only inside start().
     */
    const script = `
      const { filedrop } = await import('auto-channels/builtins')
      console.log('imported')
      try { await filedrop().start({ emit() {} }) } catch (err) { console.log('start threw: ' + err.message) }
    `
    const env: Record<string, string | undefined> = { ...process.env, AUTO_CHANNELS_ROOT: '' }
    delete env.FILEDROP_DIR
    const run = Bun.spawnSync([process.execPath, '-e', script], { env, cwd: join(import.meta.dir, '..', '..', '..') })
    const out = run.stdout.toString()
    expect(out).toContain('imported')
    expect(out).toContain('start threw: AUTO_CHANNELS_ROOT must not be empty')
  })

  test('does not emit a truncated read for a file still being written past the debounce window', async () => {
    /*
     * A debounced fs event only guarantees quiet *between events*, not that
     * the writer has actually finished -- a slow writer (a download, a
     * streamed copy) with an inter-chunk gap longer than the debounce window
     * would otherwise get emitted mid-write. See the filedrop builtin's own
     * comment on checkStable().
     */
    dir = mkdtempSync(join(tmpdir(), 'filedrop-test-'))
    process.env.FILEDROP_DIR = dir
    const ctx = createMockContext()
    stop = await startWatching(ctx)

    const path = join(dir, 'slow.txt')
    writeFileSync(path, 'chunk1-')
    await new Promise(resolve => setTimeout(resolve, 200)) // gap exceeding the 150ms debounce
    appendFileSync(path, 'chunk2-complete')

    await waitFor(() => ctx.emitted.length >= 1)
    // Give any further (wrongly early) emit a chance to arrive before asserting.
    await new Promise(resolve => setTimeout(resolve, 300))

    expect(ctx.emitted).toHaveLength(1) // never truncated, never emitted twice
    expect(ctx.emitted[0]?.content).toBe('chunk1-chunk2-complete')
  })

  test('emits a normal, quickly-written file with no extra delay-induced duplicate', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filedrop-test-'))
    process.env.FILEDROP_DIR = dir
    const ctx = createMockContext()
    stop = await startWatching(ctx)

    writeFileSync(join(dir, 'fast.txt'), 'written all at once')
    await waitFor(() => ctx.emitted.length >= 1)
    await new Promise(resolve => setTimeout(resolve, 300))

    expect(ctx.emitted).toHaveLength(1)
    expect(ctx.emitted[0]?.content).toBe('written all at once')
  })

  /*
   * stop() closes the watcher but leaves pending stability checks running
   * (the late delivery is preserved, not cancelled). A
   * check first looks 150 ms after the watch event and emits no earlier than
   * its second look, 300 ms after; the event itself lands within a few ms.
   * So at 200 ms the file has been seen and nothing has been emitted yet: a
   * timing bet, listed in CONTRIBUTING.md.
   */
  test('a pending stability check still emits after stop() (late delivery preserved)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filedrop-test-'))
    process.env.FILEDROP_DIR = dir
    const ctx = createMockContext()
    stop = await startWatching(ctx)

    writeFileSync(join(dir, 'late.txt'), 'seen before stop')
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(ctx.emitted).toHaveLength(0)
    stop()

    await waitFor(() => ctx.emitted.length >= 1)
    expect(ctx.emitted[0]?.content).toBe('seen before stop')
  })

  test('a file still growing when stop() is called is emitted once, complete', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filedrop-test-'))
    process.env.FILEDROP_DIR = dir
    const ctx = createMockContext()
    stop = await startWatching(ctx)

    const path = join(dir, 'growing.txt')
    writeFileSync(path, 'chunk1-')
    await new Promise(resolve => setTimeout(resolve, 200)) // the first look has run; the second is pending
    stop()
    appendFileSync(path, 'chunk2-complete')

    await waitFor(() => ctx.emitted.length >= 1)
    await new Promise(resolve => setTimeout(resolve, 300)) // a duplicate would follow within another window

    expect(ctx.emitted).toHaveLength(1)
    expect(ctx.emitted[0]?.content).toBe('chunk1-chunk2-complete')
  })

  test('does not follow a symlink dropped into the directory, even one pointing at a real file', async () => {
    /*
     * statSync()/existsSync() both follow symlinks -- a symlink dropped into
     * FILEDROP_DIR (even by accident: an editor's atomic-save-via-symlink-
     * swap, a broken archive extraction, `cp -s`) would otherwise get its
     * *target's* contents read and broadcast, keyed only by the harmless-
     * looking symlink name -- including files entirely outside this
     * directory that the daemon's OS user can read. Each look opens with
     * O_NOFOLLOW and reads that fd, so this also pins the fix for a symlink
     * swapped in after a check; see the filedrop builtin's OPEN_FLAGS.
     */
    outsideDir = mkdtempSync(join(tmpdir(), 'filedrop-outside-'))
    const secretPath = join(outsideDir, 'secret.txt')
    writeFileSync(secretPath, 'should never be broadcast')

    dir = mkdtempSync(join(tmpdir(), 'filedrop-test-'))
    process.env.FILEDROP_DIR = dir
    const ctx = createMockContext()
    stop = await startWatching(ctx)

    symlinkSync(secretPath, join(dir, 'innocuous.txt'))
    await new Promise(resolve => setTimeout(resolve, 500)) // past both debounce windows

    expect(ctx.emitted).toHaveLength(0)
  })

  test('a dropped FIFO is ignored without blocking the files after it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'filedrop-test-'))
    process.env.FILEDROP_DIR = dir
    const ctx = createMockContext()
    stop = await startWatching(ctx)

    expect(Bun.spawnSync(['mkfifo', join(dir, 'pipe')]).exitCode).toBe(0)
    await new Promise(resolve => setTimeout(resolve, 400)) // past both looks at the FIFO; a blocking open hangs here
    writeFileSync(join(dir, 'after.txt'), 'still delivered')
    await waitFor(() => ctx.emitted.length >= 1)

    expect(ctx.emitted.map(event => event.meta?.filename)).toEqual(['after.txt'])
  })
})

describe('filedrop factory', () => {
  test('the description states the size-stability window, not a completeness guarantee', () => {
    expect(filedrop.description).toContain('holds steady for 150 ms')
    expect(filedrop.description).toContain('can be read mid-write')
  })

  test('dir option beats the FILEDROP_DIR env var', async () => {
    dir = mkdtempSync(join(tmpdir(), 'builtin-filedrop-'))
    process.env.FILEDROP_DIR = '' // would throw ("must not be empty") if consulted
    const ctx = createMockContext()
    stop = await startForTest(filedropFactory({ dir }), ctx)
    await new Promise(resolve => setTimeout(resolve, 150)) // FSEvents startup latency, see startWatching above

    writeFileSync(join(dir, 'note.txt'), 'dropped into the configured dir')
    await waitFor(() => ctx.emitted.length >= 1)
    expect(ctx.emitted[0]?.content).toBe('dropped into the configured dir')
  })

  test('an empty dir option fails naming the option', async () => {
    await expect(startForTest(filedropFactory({ dir: '' }), createMockContext())).rejects.toThrow(
      /filedrop\(\{ dir \}\) must not be empty/,
    )
  })

  test('an empty name option fails at factory time — it is the subscription key and log scope', () => {
    expect(() => filedropFactory({ name: '' })).toThrow(/filedrop\(\{ name \}\) must not be empty/)
  })
})
