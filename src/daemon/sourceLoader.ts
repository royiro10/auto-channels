import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { startDirectoryWatch } from '../shared/dirWatch.ts'
import { createLogger } from '../shared/log.ts'
import type { SourceInfo } from '../shared/protocol.ts'
import type { Source, StopFn } from '../shared/source.ts'

const log = createLogger('sources')
const DEBOUNCE_MS = 150

/** Who emitted: captured per instance before start(), so delivery never depends on registry timing. */
export type SourceIdentity = Pick<SourceInfo, 'name' | 'defaultSubscribed'>

function isSource(value: unknown): value is Source {
  return (
    typeof value === 'object' &&
    value !== null &&
    // Non-blank: the name is the subscription key and the origin attribute.
    typeof (value as Source).name === 'string' &&
    (value as Source).name.trim() !== '' &&
    // Non-blank, not just present: a blank description defeats Source.description as silently as a missing one.
    typeof (value as Source).description === 'string' &&
    (value as Source).description.trim() !== '' &&
    typeof (value as Source).start === 'function'
  )
}

// Leading underscore disables a source without deleting it (e.g. _webhook.ts).
function isSourceFile(file: string): boolean {
  return file.endsWith('.ts') && !file.startsWith('_')
}

/** One per file. The slot object itself is the generation token of the load that created it. */
interface Slot {
  stop?: StopFn
  info?: SourceInfo
  failed?: true
}

export interface SourceLoader {
  /** One row per file with a live, successfully started instance. Order unspecified. */
  list(): SourceInfo[]
  /** Synchronous. Closes the watcher and timers and stops every current instance (not awaited); publishes NO registry change. */
  close(): void
}

/**
 * Load, and hot-reload on change, every source file in `dir` (absolute, resolved by the daemon).
 * Known limitations: a hung start() is a zombie no reload can stop; instances of one file briefly
 * overlap when start() outlasts the debounce; a file deleted between existsSync and realpathSync
 * logs one "failed to load" before its deletion event retires it.
 */
export function startSourceLoader(options: {
  dir: string
  /** Identity captured before start(); may be called at any time, including after stop/close. */
  emit(source: SourceIdentity, event: unknown): void
  /** Called synchronously after every registry mutation; list() already reflects it. Must not throw. */
  onRegistryChange(sources: SourceInfo[]): void
}): SourceLoader {
  const { dir, emit, onRegistryChange } = options
  mkdirSync(dir, { recursive: true }) // a fresh consumer may not have it yet

  /*
   * Loads of one file may overlap (a hung start() must never block the agent's fix).
   * A load has effects only while its slot is the file's current one and the loader
   * is open: the latest request wins, and nothing starts after close().
   */
  const slots = new Map<string, Slot>()
  let closed = false

  function list(): SourceInfo[] {
    return [...slots.values()].flatMap(slot => (slot.info ? [slot.info] : []))
  }

  /*
   * stop() is user code: a throw must not abort other stops or the daemon's shutdown.
   * An async stop() is invoked now and never awaited; its rejection is
   * caught, since an unhandled one exits the daemon.
   */
  function safeStop(file: string, stop: StopFn): Promise<void> {
    try {
      return Promise.resolve(stop()).then(undefined, (err: unknown) =>
        log(`${file}'s stop() rejected, ignoring: ${String(err)}`),
      )
    } catch (err) {
      log(`${file}'s stop() threw, ignoring: ${String(err)}`)
      return Promise.resolve()
    }
  }

  /*
   * A start() can fail because an older instance still holds its resource (EADDRINUSE
   * on an edited webhook). So once a stop() of the file settles, a failed
   * current load gets exactly one retry: no timer, no loop.
   */
  function stopThenRetry(file: string, stop: StopFn): void {
    void safeStop(file, stop).then(() => {
      if (slots.get(file)?.failed) void apply(file)
    })
  }

  // Stop before notify: a registry snapshot without the source follows its stop() (e2e-08).
  function retire(file: string): void {
    const slot = slots.get(file)
    if (!slot) return
    slots.delete(file)
    if (slot.stop) stopThenRetry(file, slot.stop)
    if (slot.info && !closed) onRegistryChange(list())
  }

  async function apply(file: string): Promise<void> {
    retire(file)
    const path = join(dir, file)
    if (closed || !existsSync(path)) return // a deleted file is a removal, not a failure
    const slot: Slot = {}
    slots.set(file, slot)
    const live = () => !closed && slots.get(file) === slot

    try {
      /*
       * A unique query forces a fresh evaluation, and each load evicts exactly its own
       * key, or every reload leaks its module. Bun keys the cache by realpath:
       * a symlinked path's key is never found. Transitive imports stay cached.
       */
      const spec = `${realpathSync(path)}?t=${Date.now()}_${Math.random()}`
      const mod: unknown = await import(spec).finally(() => {
        delete require.cache[spec]
      })
      if (!live()) return // superseded during the import: never started
      const source = (mod as { default?: unknown }).default
      if (!isSource(source)) {
        log(`${file} does not export a valid Source (default export with name + description + start)`)
        return
      }
      const identity = { name: source.name, defaultSubscribed: source.defaultSubscribed !== false }
      const stop = await source.start({ emit: event => emit(identity, event) })
      if (!live()) {
        // Superseded (or closed) while start() ran: stop this instance now instead of orphaning it.
        if (typeof stop === 'function') stopThenRetry(file, stop)
        return
      }
      if (typeof stop === 'function') slot.stop = stop
      slot.info = { ...identity, description: source.description, file }
      onRegistryChange(list())
      log(`loaded ${source.name} (${file}): ${source.description}`)
    } catch (err) {
      if (!live()) return // a superseded load's failure says nothing about the current file
      slot.failed = true
      log(`failed to load ${file}: ${String(err)}`)
    }
  }

  // Debounce per file: editors emit multiple fs events per save.
  const debounce = new Map<string, ReturnType<typeof setTimeout>>()
  const watcher = startDirectoryWatch(dir, file => {
    if (!isSourceFile(file)) return
    clearTimeout(debounce.get(file))
    debounce.set(
      file,
      setTimeout(() => {
        debounce.delete(file)
        log(`reloading ${file}`)
        void apply(file)
      }, DEBOUNCE_MS),
    )
  })
  /*
   * Watch first, then list: a file created between a listing and the watch's
   * own initial snapshot was ignored until its next edit. In this
   * order it is in the listing, the snapshot, or reported as a change; the
   * worst case is one redundant reload.
   */
  for (const file of readdirSync(dir).filter(isSourceFile)) void apply(file)

  return {
    close(): void {
      closed = true
      watcher.close()
      for (const timeout of debounce.values()) clearTimeout(timeout)
      debounce.clear()
      for (const file of [...slots.keys()]) retire(file)
    },
    list,
  }
}
