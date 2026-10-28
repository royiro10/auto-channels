import { lstatSync, readdirSync, watch } from 'node:fs'
import { join } from 'node:path'

/*
 * fs.watch's per-event filename is not a change list: Bun on macOS coalesces a
 * burst into ONE event naming only the first file. So an event only means "this
 * directory changed": every event re-lists it and diffs a snapshot.
 */

/** Identity of a directory entry's current state; any write, replace, or type change alters it. */
function signatureOf(path: string): string | undefined {
  try {
    const stats = lstatSync(path)
    return `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.mode}`
  } catch {
    return undefined // removed in a race with the listing
  }
}

/*
 * A deleted (or replaced-by-a-file) directory reads as empty: this runs from timers,
 * where a throw crashes the daemon. Every known entry is then reported removed, and
 * the periodic rescan picks up a recreated directory.
 */
function snapshot(dir: string): Map<string, string> {
  const entries = new Map<string, string>()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return entries
    throw err
  }
  for (const name of names) {
    const signature = signatureOf(join(dir, name))
    if (signature !== undefined) entries.set(name, signature)
  }
  return entries
}

/*
 * Even a rescanning watch misses changes under load: a burst's tail coalesces into
 * the event being handled, or events are lost. Two idempotent extra rescans cover it:
 * a trailing one after each event, and an unref'd periodic safety net.
 */
const TRAILING_RESCAN_MS = 100
const PERIODIC_RESCAN_MS = 1000

/**
 * Watch `dir` (non-recursively) and call `onChange(name)` for every entry
 * that was created, modified, or removed — at least once per change, even
 * when the platform coalesces a burst into one event or drops events. Entries
 * present when the watch starts are not reported. Filtering (dotfiles,
 * extensions) and debouncing are the caller's job.
 */
export function startDirectoryWatch(dir: string, onChange: (name: string) => void): { close(): void } {
  let known = snapshot(dir)
  let trailing: ReturnType<typeof setTimeout> | undefined

  function rescan(): void {
    const current = snapshot(dir)
    const changed: string[] = []
    for (const [name, signature] of current) if (known.get(name) !== signature) changed.push(name)
    for (const name of known.keys()) if (!current.has(name)) changed.push(name)
    known = current
    for (const name of changed) onChange(name)
  }

  /*
   * The event's filename is ignored, not just distrusted: macOS also delivers LATE
   * events for writes already seen, and acting on them needlessly reloaded a source.
   * Only a real signature change counts.
   */
  const watcher = watch(dir, () => {
    rescan()
    clearTimeout(trailing)
    trailing = setTimeout(rescan, TRAILING_RESCAN_MS)
  })
  watcher.on('error', () => watcher.close()) // unhandled, it throws; the periodic rescan carries on
  const periodic = setInterval(rescan, PERIODIC_RESCAN_MS)
  periodic.unref()

  return {
    close() {
      watcher.close()
      clearTimeout(trailing)
      clearInterval(periodic)
    },
  }
}
