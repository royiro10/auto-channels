/*
 * The loader at its real interface: startSourceLoader on a real temp dir with
 * the real watcher. Fixture sources coordinate with the test through a
 * per-test probe on globalThis (starts, live instances, stops, and one
 * ordered trace shared with onRegistryChange), and log lines are captured
 * from console.error. One case per loader invariant (see startSourceLoader).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type SourceLoader, startSourceLoader } from '../../src/daemon/sourceLoader.ts'
import { waitFor } from '../../src/shared/testing.ts'

interface Probe {
  starts: string[]
  live: string[]
  stops: string[]
  order: string[]
  [flag: string]: unknown
}
const probes: Record<string, Probe> = {}
;(globalThis as { __loaderTest?: Record<string, Probe> }).__loaderTest = probes

let probeCount = 0
let dir: string
let loader: SourceLoader | undefined
let logs: string[]
let consoleError: ReturnType<typeof spyOn>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loader-test-'))
  logs = []
  consoleError = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  })
})

afterEach(() => {
  loader?.close()
  loader = undefined
  consoleError.mockRestore()
  rmSync(dir, { recursive: true, force: true })
})

/** A fresh probe; its key is the fixture sources' name. */
function newProbe(): [string, Probe] {
  const key = `k${++probeCount}`
  const probe: Probe = { starts: [], live: [], stops: [], order: [] }
  probes[key] = probe
  return [key, probe]
}

/*
 * A recording source. `top` runs at module top level, `start` inside start()
 * before the instance counts as live, `stop` at the end of its stop function.
 */
function source(key: string, version: string, code: { top?: string; start?: string; stop?: string } = {}): string {
  return `const p = globalThis.__loaderTest['${key}']
${code.top ?? ''}
export default {
  name: '${key}',
  description: '${version}',
  async start(ctx) {
    p.starts.push('${version}')
    ${code.start ?? ''}
    p.live.push('${version}')
    return () => {
      p.live.splice(p.live.indexOf('${version}'), 1)
      p.stops.push('${version}')
      p.order.push('stop ${version}')
      ${code.stop ?? ''}
    }
  },
}
`
}

// Holds the module's top-level evaluation until the test calls probe.release().
const GATED_IMPORT = { top: 'await new Promise(resolve => { p.release = resolve })\np.imported = true' }

function write(file: string, content: string): void {
  writeFileSync(join(dir, file), content)
}

function start(probe: Probe | undefined, files: Record<string, string> = {}, sourcesDir?: string): SourceLoader {
  for (const [file, content] of Object.entries(files)) write(file, content)
  loader = startSourceLoader({
    dir: sourcesDir ?? dir,
    emit: () => {},
    onRegistryChange: sources => probe?.order.push(`registry [${sources.map(s => s.description).join(',')}]`),
  })
  return loader
}

function listed(version: string): boolean {
  return loader?.list().some(s => s.description === version) ?? false
}

describe('startSourceLoader: characterization (C29)', () => {
  test('isSource rejects a missing or blank name, a missing or blank description, and a missing start', async () => {
    const files = {
      'no-name.ts': `export default { description: 'd', start() {} }`,
      'blank-name.ts': `export default { name: '  ', description: 'd', start() {} }`,
      'no-description.ts': `export default { name: 'n', start() {} }`,
      'blank-description.ts': `export default { name: 'n', description: ' ', start() {} }`,
      'no-start.ts': `export default { name: 'n', description: 'd' }`,
    }
    const [, probe] = newProbe()
    start(probe, files)
    await waitFor(() =>
      Object.keys(files).every(file => logs.some(line => line.includes(`${file} does not export a valid Source`))),
    )
    expect(loader?.list()).toEqual([])
    expect(probe.order).toEqual([])
  })

  test('_-prefixed and non-.ts files are ignored', async () => {
    const [key, probe] = newProbe()
    start(probe, { '_off.ts': source(key, 'off'), 'notes.js': source(key, 'js'), 'on.ts': source(key, 'on') })
    await waitFor(() => listed('on'))
    /*
     * The same filter on the watch path: the ignored files are written first,
     * so if they were not ignored their (equally debounced) loads would start
     * no later than the barrier's.
     */
    write('_later.ts', source(key, 'later-off'))
    write('later.js', source(key, 'later-js'))
    write('barrier.ts', source(key, 'barrier'))
    await waitFor(() => listed('barrier'))
    expect(probe.starts.sort()).toEqual(['barrier', 'on'])
  })

  test('a missing dir is created', () => {
    const sourcesDir = join(dir, 'nested', 'sources')
    start(undefined, {}, sourcesDir)
    expect(existsSync(sourcesDir)).toBe(true)
  })

  test('a file present at start loads exactly once', async () => {
    const [key, probe] = newProbe()
    start(probe, { 'a.ts': source(key, 'v1') })
    await waitFor(() => listed('v1'))
    // Negative window: one periodic rescan (1 s) plus the 150 ms debounce, so a redundant reload would have started.
    await Bun.sleep(1300)
    expect(probe.starts).toEqual(['v1'])
    expect(probe.order).toEqual(['registry [v1]'])
  })

  test('stop() is invoked before the registry snapshot that lacks the source', async () => {
    const [key, probe] = newProbe()
    start(probe, { 'a.ts': source(key, 'v1') })
    await waitFor(() => listed('v1'))
    unlinkSync(join(dir, 'a.ts'))
    await waitFor(() => probe.order.includes('registry []'))
    expect(probe.order.indexOf('stop v1')).toBeGreaterThanOrEqual(0)
    expect(probe.order.indexOf('stop v1')).toBeLessThan(probe.order.indexOf('registry []'))
  })

  test('an edit during a slow start() leaves exactly one live instance (e2e-21 in unit form)', async () => {
    const [key, probe] = newProbe()
    const slow = { start: 'await new Promise(resolve => setTimeout(resolve, 500))' }
    start(probe)
    write('a.ts', source(key, 'v1', slow))
    await waitFor(() => probe.starts.includes('v1'))
    write('a.ts', source(key, 'v2', slow))
    await waitFor(() => listed('v2') && probe.stops.includes('v1') && probe.live.length === 1, 5000)
    expect(probe.live).toEqual(['v2'])
  })

  test('S5: an edited version replaces a start() that never resolves', async () => {
    const [key, probe] = newProbe()
    start(probe)
    write('a.ts', source(key, 'v1', { start: 'await new Promise(() => {})' }))
    await waitFor(() => probe.starts.includes('v1'))
    write('a.ts', source(key, 'v2'))
    await waitFor(() => listed('v2'))
    expect(probe.live).toEqual(['v2'])
  })

  test('U10: an edited version replaces a module whose top-level await never resolves', async () => {
    const [key, probe] = newProbe()
    start(probe)
    write('a.ts', source(key, 'v1', { top: 'p.imported = true\nawait new Promise(() => {})' }))
    await waitFor(() => probe.imported === true)
    write('a.ts', source(key, 'v2'))
    await waitFor(() => listed('v2'))
    expect(probe.starts).toEqual(['v2'])
  })

  test('U13: an edit after a stop() whose promise never settles still loads the new version, and the registry lists it', async () => {
    const [key, probe] = newProbe()
    start(probe, { 'a.ts': source(key, 'v1', { stop: 'return new Promise(() => {})' }) })
    await waitFor(() => listed('v1'))
    write('a.ts', source(key, 'v2'))
    await waitFor(() => listed('v2'))
    expect(loader?.list().map(s => s.description)).toEqual(['v2'])
    expect(probe.live).toEqual(['v2'])
  })

  test('W1: 20 writes 24 ms apart end with the final version live, one live instance, at most 2 start() calls', async () => {
    const [key, probe] = newProbe()
    start(probe, { 'a.ts': source(key, 'v0') })
    await waitFor(() => listed('v0'))
    for (let i = 1; i <= 20; i++) {
      write('a.ts', source(key, `v${i}`))
      await Bun.sleep(24)
    }
    await waitFor(() => listed('v20') && probe.live.length === 1, 5000)
    expect(probe.live).toEqual(['v20'])
    const burstStarts = probe.starts.filter(version => version !== 'v0')
    expect(burstStarts.length).toBeLessThanOrEqual(2) // measured: 1
    expect(burstStarts.at(-1)).toBe('v20')
  })

  test('W5: a file written in two halves 50 ms apart produces no failed to load line', async () => {
    const [key, probe] = newProbe()
    start(probe, { 'ready.ts': source(key, 'ready') })
    await waitFor(() => listed('ready'))
    const whole = source(key, 'whole')
    write('a.ts', whole.slice(0, whole.length / 2))
    await Bun.sleep(50)
    write('a.ts', whole)
    await waitFor(() => listed('whole'))
    expect(logs.filter(line => line.includes('failed to'))).toEqual([])
  })

  test('per-file independence: b.ts written once loads while a.ts is still being rewritten every 50 ms', async () => {
    const [key, probe] = newProbe()
    start(probe)
    let bLoadedDuringBurst = false
    for (let i = 1; i <= 20; i++) {
      if (listed('b')) bLoadedDuringBurst = true
      write('a.ts', source(key, `a${i}`))
      if (i === 1) write('b.ts', source(key, 'b'))
      await Bun.sleep(50)
    }
    expect(bLoadedDuringBurst).toBe(true)
  })
})

describe('startSourceLoader: close() invalidates in-flight loads', () => {
  test('close during a slow start(): never listed, onRegistryChange not called, stop invoked exactly once', async () => {
    const [key, probe] = newProbe()
    const gated = { start: 'await new Promise(resolve => { p.release = resolve })\np.resumed = true' }
    const loader = start(probe, { 'a.ts': source(key, 'v1', gated) })
    await waitFor(() => typeof probe.release === 'function')
    loader.close()
    ;(probe.release as () => void)()
    await waitFor(() => probe.resumed === true)
    await Bun.sleep(50) // the loader's continuation after start() runs within microtasks of its resolution
    expect(loader.list()).toEqual([])
    expect(probe.order).toEqual(['stop v1'])
  })

  test('close while the import is still pending: start() is never called', async () => {
    const [key, probe] = newProbe()
    const loader = start(probe, { 'a.ts': source(key, 'v1', GATED_IMPORT) })
    await waitFor(() => typeof probe.release === 'function')
    loader.close()
    ;(probe.release as () => void)()
    await waitFor(() => probe.imported === true)
    await Bun.sleep(50) // the loader's continuation after the import runs within microtasks of its settling
    expect(probe.starts).toEqual([])
    expect(probe.order).toEqual([])
  })
})

describe('startSourceLoader: slot identity (C31)', () => {
  test('a load superseded while its import is pending never calls start() and never registers', async () => {
    const [key, probe] = newProbe()
    start(probe)
    write('a.ts', source(key, 'v1', GATED_IMPORT))
    await waitFor(() => typeof probe.release === 'function')
    write('a.ts', source(key, 'v2'))
    await waitFor(() => listed('v2'))
    ;(probe.release as () => void)()
    await waitFor(() => probe.imported === true)
    await Bun.sleep(50) // the loader's continuation after the import runs within microtasks of its settling
    expect(probe.starts).toEqual(['v2'])
    expect(probe.order).toEqual(['registry [v2]'])
  })
})

describe('startSourceLoader: retry once after a stop settles', () => {
  // Claims one resource per probe; a second claim throws, like EADDRINUSE on a webhook port.
  const CLAIM = "if (p.held) throw new Error('held')\np.held = true"
  const SYNC_RELEASE = 'p.held = false'
  const ASYNC_RELEASE = 'return new Promise(resolve => setTimeout(() => { p.held = false; resolve() }, 100))'

  test('U14: an ordinary edit of a source whose stop() releases 100 ms later ends with the new version loaded', async () => {
    const [key, probe] = newProbe()
    const claiming = (version: string) => source(key, version, { start: CLAIM, stop: ASYNC_RELEASE })
    start(probe, { 'a.ts': claiming('v1') })
    await waitFor(() => listed('v1'))
    write('a.ts', claiming('v2'))
    await waitFor(() => listed('v2'), 3000, 'v2 loaded')
    expect(probe.live).toEqual(['v2'])
    expect(logs.filter(line => line.includes('failed to load a.ts: Error: held'))).toHaveLength(1)
  })

  test.each([
    ['S2: start() claims, then awaits 300 ms', 300, SYNC_RELEASE],
    ['U11: the stale start() holds 1.5 s', 1500, SYNC_RELEASE],
    ['U12: the stale stop() releases asynchronously', 300, ASYNC_RELEASE],
  ])(
    '%s; an overlapping edit ends with the new version loaded',
    async (_title, holdMs, release) => {
      const [key, probe] = newProbe()
      const slowClaim = {
        start: `${CLAIM}\nawait new Promise(resolve => setTimeout(resolve, ${holdMs}))`,
        stop: release,
      }
      start(probe)
      write('a.ts', source(key, 'v1', slowClaim))
      await waitFor(() => probe.starts.includes('v1'))
      write('a.ts', source(key, 'v2', slowClaim))
      await waitFor(() => listed('v2'), 8000, 'v2 loaded') // U11: v1's 1.5 s hold, then v2's own
      expect(probe.live).toEqual(['v2'])
    },
    10_000,
  )

  test('at most one retry per stop event: a second failure stays failed when no further stop happens', async () => {
    const [key, probe] = newProbe()
    start(probe, { 'a.ts': source(key, 'v1', { stop: ASYNC_RELEASE }) })
    await waitFor(() => listed('v1'))
    write('a.ts', source(key, 'v2', { start: "throw new Error('broken')" }))
    await waitFor(() => probe.starts.filter(version => version === 'v2').length === 2, 3000, 'the retry')
    await Bun.sleep(500) // nothing but a settling stop() drives a retry, and no instance is left to stop
    expect(probe.starts).toEqual(['v1', 'v2', 'v2'])
    expect(loader?.list()).toEqual([])
  })
})

describe('startSourceLoader: each load evicts its own module key', () => {
  // require.cache keys left behind by the loader's `?t=` imports of `path`.
  function cachedLoads(path: string): string[] {
    const real = realpathSync(path)
    return Object.keys(require.cache).filter(key => key.startsWith(`${real}?t=`))
  }

  test('after a successful load, no require.cache key contains the source path with ?t=', async () => {
    const [key, probe] = newProbe()
    start(probe, { 'a.ts': source(key, 'v1') })
    await waitFor(() => listed('v1'))
    expect(cachedLoads(join(dir, 'a.ts'))).toEqual([])
    // Canary: Bun still registers a `?t=` import under the file's realpath, so the eviction is not vacuous.
    const canary = `${realpathSync(join(dir, 'a.ts'))}?t=canary`
    await import(canary)
    expect(cachedLoads(join(dir, 'a.ts'))).toEqual([canary])
    delete require.cache[canary]
  })

  test('the same with dir reached through a symlinked directory', async () => {
    const [key, probe] = newProbe()
    mkdirSync(join(dir, 'real'))
    const link = join(dir, 'link')
    symlinkSync(join(dir, 'real'), link)
    writeFileSync(join(link, 'a.ts'), source(key, 'v1'))
    start(probe, {}, link)
    await waitFor(() => listed('v1'))
    expect(cachedLoads(join(link, 'a.ts'))).toEqual([])
  })

  test('a syntax error, then a fix, recovers', async () => {
    const [key, probe] = newProbe()
    start(probe, { 'a.ts': 'export default {' })
    await waitFor(() => logs.some(line => line.includes('failed to load a.ts')))
    write('a.ts', source(key, 'fixed'))
    await waitFor(() => listed('fixed'))
    expect(probe.live).toEqual(['fixed'])
  })
})

describe('startSourceLoader: only a current load can fail (C35)', () => {
  test('deleting a loaded file logs no failed line', async () => {
    const [key, probe] = newProbe()
    start(probe, { 'a.ts': source(key, 'v1') })
    await waitFor(() => listed('v1'))
    unlinkSync(join(dir, 'a.ts'))
    await waitFor(() => probe.order.includes('registry []'))
    await Bun.sleep(200) // a failing re-import of the missing file would log within milliseconds of the retire
    expect(logs.filter(line => line.includes('failed'))).toEqual([])
  })

  test('a load superseded during a failing import logs no failed line', async () => {
    const [key, probe] = newProbe()
    start(probe)
    write('a.ts', source(key, 'v1', { top: `${GATED_IMPORT.top}\nthrow new Error('v1 boom')` }))
    await waitFor(() => typeof probe.release === 'function')
    write('a.ts', source(key, 'v2'))
    await waitFor(() => listed('v2'))
    ;(probe.release as () => void)()
    await waitFor(() => probe.imported === true)
    await Bun.sleep(50) // the loader's catch runs within microtasks of the import's rejection
    expect(logs.filter(line => line.includes('failed'))).toEqual([])
  })
})
