/*
 * config.ts is pure: every case passes a literal env and cwd, so no test
 * mutates process.env or re-imports a module to pick up a knob.
 */
import { describe, expect, test } from 'bun:test'
import { readPath, readPositiveInt, resolveConfig, resolveRoot, runPaths } from '../../src/shared/config.ts'

const CWD = '/project'
const VAR = 'SOME_KNOB'

describe('readPositiveInt', () => {
  const read = (raw?: string) => readPositiveInt(VAR, 42, raw === undefined ? {} : { [VAR]: raw })

  test('returns the default when unset', () => {
    expect(read()).toBe(42)
  })

  test('returns the parsed value when set to a valid positive integer', () => {
    expect(read('100')).toBe(100)
  })

  test('rejects a non-numeric value instead of silently returning NaN', () => {
    // NaN comparisons are always false, and setInterval(fn, NaN) fires every 1 ms.
    expect(() => read('not-a-number')).toThrow(/must be a positive integer/)
  })

  test('rejects zero', () => {
    expect(() => read('0')).toThrow(/must be a positive integer/)
  })

  test('rejects a negative number', () => {
    expect(() => read('-5')).toThrow(/must be a positive integer/)
  })

  test('rejects a non-integer number', () => {
    expect(() => read('1.5')).toThrow(/must be a positive integer/)
  })

  test('rejects an empty string', () => {
    // Number('') is 0, not NaN — a distinct gotcha from the non-numeric case.
    expect(() => read('')).toThrow(/must be a positive integer/)
  })

  test('error message names the specific env var and the invalid value', () => {
    expect(() => read('garbage')).toThrow('SOME_KNOB must be a positive integer, got "garbage"')
  })
})

describe('readPath', () => {
  const read = (raw?: string, fallback = '/default') =>
    readPath(VAR, fallback, raw === undefined ? {} : { [VAR]: raw }, CWD)

  test('returns the default when unset', () => {
    expect(read()).toBe('/default')
  })

  test('returns the value when set to a non-empty string', () => {
    expect(read('/custom/path')).toBe('/custom/path')
  })

  test('rejects an explicitly-set empty string instead of silently accepting it', () => {
    // '' is not nullish, so `?? default` would not catch it.
    expect(() => read('')).toThrow(/must not be empty/)
  })

  test('rejects a whitespace-only string', () => {
    expect(() => read('   ')).toThrow(/must not be empty/)
  })

  test('error message names the specific env var and the invalid value', () => {
    expect(() => read('')).toThrow('SOME_KNOB must not be empty, got ""')
  })

  test('trims leading/trailing whitespace instead of silently baking it into the returned path', () => {
    expect(read('  /some/path  ')).toBe('/some/path')
  })

  test('preserves whitespace inside the path, only trims the ends', () => {
    expect(read('  /Users/dev/My Documents/sources  ')).toBe('/Users/dev/My Documents/sources')
  })

  test('resolves a relative override against cwd', () => {
    /*
     * Left relative, fs calls resolve against cwd but dynamic import()
     * resolves against the importing module — a relative SOURCES_DIR listed
     * fine and then failed to load every file in it.
     */
    expect(read('./event-sources')).toBe('/project/event-sources')
  })

  test('a bare relative name (no ./ prefix) also resolves against cwd', () => {
    expect(read('my-sources')).toBe('/project/my-sources')
  })

  test('an absolute override passes through unchanged', () => {
    expect(read('/absolute/path')).toBe('/absolute/path')
  })

  test('the default is returned as-is, not re-resolved', () => {
    expect(read(undefined, 'relative/default')).toBe('relative/default')
  })
})

describe('resolveRoot', () => {
  test('defaults to .channels/ under cwd when unset', () => {
    expect(resolveRoot({}, CWD)).toBe('/project/.channels')
  })

  test('AUTO_CHANNELS_ROOT replaces the .channels directory entirely (no segment appended)', () => {
    expect(resolveRoot({ AUTO_CHANNELS_ROOT: '/tmp/some-other-root' }, CWD)).toBe('/tmp/some-other-root')
  })

  test("AUTO_CHANNELS_ROOT='.' reproduces the old flat layout: everything at the project root", () => {
    expect(resolveRoot({ AUTO_CHANNELS_ROOT: '.' }, CWD)).toBe(CWD)
  })

  test('a relative override resolves against cwd (what the scaffolded .mcp.json env block relies on)', () => {
    expect(resolveRoot({ AUTO_CHANNELS_ROOT: './.channels' }, CWD)).toBe('/project/.channels')
  })

  test('rejects an empty AUTO_CHANNELS_ROOT instead of silently resolving every path against cwd', () => {
    expect(() => resolveRoot({ AUTO_CHANNELS_ROOT: '' }, CWD)).toThrow(/AUTO_CHANNELS_ROOT must not be empty/)
  })
})

describe('runPaths', () => {
  test('derives every run-dir artifact inside the given run dir', () => {
    expect(runPaths('/tmp/some-run-dir')).toEqual({
      runDir: '/tmp/some-run-dir',
      socketPath: '/tmp/some-run-dir/daemon.sock',
      pidPath: '/tmp/some-run-dir/daemon.pid',
      lockPath: '/tmp/some-run-dir/daemon.lock',
      statusPath: '/tmp/some-run-dir/daemon.status.json',
      logPath: '/tmp/some-run-dir/daemon.log',
    })
  })

  test('rejects a run dir whose socket path would exceed the OS Unix-socket length limit, naming the fix', () => {
    // bind() on an over-length sun_path fails with a bare "Failed to listen" that never mentions length.
    const deepDir = `/tmp/${'x'.repeat(120)}`
    expect(() => runPaths(deepDir)).toThrow(/CHANNEL_RUN_DIR to a short path/)
    expect(() => runPaths(deepDir)).toThrow(/byte/)
  })

  test('multi-byte characters count by their UTF-8 byte length, not their character count', () => {
    // 30 four-byte emoji are 120 bytes from only 60 UTF-16 code units.
    const emojiDir = `/tmp/${'🎉'.repeat(30)}`
    expect(() => runPaths(emojiDir)).toThrow(/byte/)
  })
})

describe('resolveConfig', () => {
  test('defaults: everything derives from <cwd>/.channels', () => {
    expect(resolveConfig({}, CWD)).toEqual({
      root: '/project/.channels',
      runDir: '/project/.channels/run',
      socketPath: '/project/.channels/run/daemon.sock',
      pidPath: '/project/.channels/run/daemon.pid',
      lockPath: '/project/.channels/run/daemon.lock',
      statusPath: '/project/.channels/run/daemon.status.json',
      logPath: '/project/.channels/run/daemon.log',
      sourcesDir: '/project/.channels/sources',
      idleShutdownMs: 60_000,
      maxClientBufferBytes: 4 * 1024 * 1024,
      backpressureCheckMs: 2000,
    })
  })

  test('every override is honoured; relative paths resolve against cwd', () => {
    const config = resolveConfig(
      {
        AUTO_CHANNELS_ROOT: 'root',
        CHANNEL_RUN_DIR: '/tmp/run',
        SOURCES_DIR: './src',
        DAEMON_IDLE_SHUTDOWN_MS: '5',
        MAX_CLIENT_BUFFER_BYTES: '6',
        BACKPRESSURE_CHECK_INTERVAL_MS: '7',
      },
      CWD,
    )
    expect(config).toMatchObject({
      root: '/project/root',
      runDir: '/tmp/run',
      socketPath: '/tmp/run/daemon.sock',
      sourcesDir: '/project/src',
      idleShutdownMs: 5,
      maxClientBufferBytes: 6,
      backpressureCheckMs: 7,
    })
  })

  test('the run dir and sources dir default under an overridden root', () => {
    expect(resolveConfig({ AUTO_CHANNELS_ROOT: '/x' }, CWD)).toMatchObject({
      runDir: '/x/run',
      sourcesDir: '/x/sources',
    })
  })

  test('rejects an empty CHANNEL_RUN_DIR instead of silently collapsing to a cwd-relative path', () => {
    expect(() => resolveConfig({ CHANNEL_RUN_DIR: '' }, CWD)).toThrow(/CHANNEL_RUN_DIR must not be empty/)
  })

  test('rejects an empty SOURCES_DIR instead of crashing later with a cryptic mkdirSync ENOENT', () => {
    expect(() => resolveConfig({ SOURCES_DIR: '' }, CWD)).toThrow(/SOURCES_DIR must not be empty/)
  })

  test.each(['DAEMON_IDLE_SHUTDOWN_MS', 'MAX_CLIENT_BUFFER_BYTES', 'BACKPRESSURE_CHECK_INTERVAL_MS'])(
    'rejects an invalid %s',
    name => {
      expect(() => resolveConfig({ [name]: 'abc' }, CWD)).toThrow(`${name} must be a positive integer, got "abc"`)
    },
  )

  test('validation order: root, then run dir, then socket length, then sources dir, then integers', () => {
    const bad = {
      AUTO_CHANNELS_ROOT: '',
      CHANNEL_RUN_DIR: '',
      SOURCES_DIR: '',
      DAEMON_IDLE_SHUTDOWN_MS: 'abc',
    }
    expect(() => resolveConfig(bad, CWD)).toThrow(/AUTO_CHANNELS_ROOT must not be empty/)
    const { AUTO_CHANNELS_ROOT: _, ...goodRoot } = bad
    expect(() => resolveConfig(goodRoot, CWD)).toThrow(/CHANNEL_RUN_DIR must not be empty/)
    expect(() => resolveConfig({ ...goodRoot, CHANNEL_RUN_DIR: `/tmp/${'x'.repeat(120)}` }, CWD)).toThrow(/byte/)
    expect(() => resolveConfig({ ...goodRoot, CHANNEL_RUN_DIR: '/tmp/r' }, CWD)).toThrow(/SOURCES_DIR/)
    expect(() => resolveConfig({ ...goodRoot, CHANNEL_RUN_DIR: '/tmp/r', SOURCES_DIR: '/s' }, CWD)).toThrow(
      /DAEMON_IDLE_SHUTDOWN_MS/,
    )
  })
})
