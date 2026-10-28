import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readPath, resolveRoot } from '../shared/config.ts'
import { startDirectoryWatch } from '../shared/dirWatch.ts'
import { createLogger } from '../shared/log.ts'
import type { Source } from '../shared/source.ts'
import { resolveName } from './options.ts'

const DEBOUNCE_MS = 150

/** Options for {@link filedrop}. An invalid one fails this source's load (logged by the daemon). */
export interface FiledropOptions {
  /** Source name (the events' `origin` and the subscription key). Pass a distinct one to watch two directories. */
  name?: string
  /** Directory to watch, created if missing. Default: the FILEDROP_DIR env var, else `<channels root>/dropbox` (both read at start()). */
  dir?: string
}

/*
 * The trust boundary is what gets written INTO the directory: a dropped symlink could
 * point anywhere the daemon's user can read. Each look opens with O_NOFOLLOW and
 * then uses only that fd, so a symlink swapped in after a check can't redirect the read.
 * O_NONBLOCK keeps a dropped FIFO from blocking the open; fstat then rejects it.
 */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

// Called inside start(): a bad channels root fails this source's start, never the builtins import.
function resolveDir(option: string | undefined): string {
  if (option === undefined) return readPath('FILEDROP_DIR', join(resolveRoot(process.env, process.cwd()), 'dropbox'))
  if (option === '') throw new Error('filedrop({ dir }) must not be empty')
  return option
}

/**
 * Watches a directory and emits each dropped plain file's full text, with `meta.filename`. A file is
 * emitted once its size is unchanged across a further 150 ms window; a writer pausing longer than that
 * can still be read mid-write. Dotfiles are ignored; checks already pending may emit after stop().
 *
 *     import { filedrop } from 'auto-channels/builtins'
 *     export default filedrop()
 */
export function filedrop(options: FiledropOptions = {}): Source {
  const name = resolveName(options.name, 'filedrop')
  const dirNote = options.dir !== undefined ? options.dir : 'the dropbox/ directory (FILEDROP_DIR env to change it)'
  return {
    name,
    description:
      `Watches ${dirNote}. content is the dropped file's full text contents; meta.filename is its ` +
      `name. Waits until its size holds steady for ${DEBOUNCE_MS} ms, so a writer pausing longer than that can be ` +
      'read mid-write. No sender gating -- same local-filesystem trust boundary as the rest of this project.',
    start(ctx) {
      const log = createLogger(name)
      const dir = resolveDir(options.dir)
      mkdirSync(dir, { recursive: true })

      const pending = new Map<string, ReturnType<typeof setTimeout>>()
      const lastCheckedSize = new Map<string, number>()

      function scheduleCheck(filename: string): void {
        clearTimeout(pending.get(filename))
        pending.set(
          filename,
          setTimeout(() => checkStable(filename), DEBOUNCE_MS),
        )
      }

      function forget(filename: string): void {
        pending.delete(filename)
        lastCheckedSize.delete(filename)
      }

      function checkStable(filename: string): void {
        let fd: number | undefined
        try {
          fd = openSync(join(dir, filename), OPEN_FLAGS)
          const stats = fstatSync(fd)
          if (!stats.isFile()) {
            forget(filename)
            return
          }

          if (lastCheckedSize.get(filename) !== stats.size) {
            /*
             * A debounced event only means quiet between events, not a finished writer:
             * a size change since the last look (or a first look) re-arms for one more window.
             */
            lastCheckedSize.set(filename, stats.size)
            scheduleCheck(filename)
            return
          }

          forget(filename)
          ctx.emit({ content: readFileSync(fd, 'utf8'), meta: { filename } })
        } catch (err) {
          forget(filename)
          const code = (err as NodeJS.ErrnoException).code
          // Gone (removed in a race) or a symlink: treated as absent.
          if (code !== 'ENOENT' && code !== 'ELOOP') log(`failed to read ${filename}: ${String(err)}`)
        } finally {
          if (fd !== undefined) closeSync(fd)
        }
      }

      const watcher = startDirectoryWatch(dir, filename => {
        if (filename.startsWith('.')) return
        scheduleCheck(filename)
      })

      log(`watching ${dir}`)
      return () => watcher.close()
    },
  }
}
