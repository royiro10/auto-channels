import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../../package.json' with { type: 'json' }
import { scaffold } from '../../src/init.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const BUN_TYPES = packageJson.devDependencies['@types/bun']

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function freshDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'auto-channels-init-'))
  return dir
}

/*
 * Deliberately no active sources: the working shapes ship as
 * auto-channels/builtins factories, and a fresh init must not start a
 * webhook server or a ticking timer nobody asked for. The starter walkthrough
 * (disabled by its leading underscore) is the only scaffolded source file.
 */
const EXPECTED_SCAFFOLD = [
  '.channels/.gitignore',
  '.channels/package.json',
  '.channels/sources/_starter.ts',
  '.channels/tsconfig.json',
  '.mcp.json',
]

describe('scaffold', () => {
  test('creates the two-entry host footprint: .mcp.json + a self-contained .channels/', () => {
    const target = freshDir()
    const { created, skipped, merged, warnings } = scaffold(target)

    expect(skipped).toEqual([])
    expect(merged).toEqual([])
    expect(warnings).toEqual([])
    expect(created.sort()).toEqual(EXPECTED_SCAFFOLD)

    // The scaffolded files are genuinely usable, not just present.
    const mcp = JSON.parse(readFileSync(join(target, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers['auto-channels'].args).toEqual([
      './.channels/node_modules/auto-channels/src/adapter/index.ts',
    ])
    /*
     * Explicit even when default: the consumer's own .mcp.json documents
     * where the tool's files live and how to move them, and pins the layout
     * against any future default change in the package.
     */
    expect(mcp.mcpServers['auto-channels'].env.AUTO_CHANNELS_ROOT).toBe('./.channels')
    // Regression guard: the exact bytes, key order included (the registration is an inlined constant).
    expect(readFileSync(join(target, '.mcp.json'), 'utf8')).toBe(
      `${JSON.stringify(
        {
          mcpServers: {
            'auto-channels': {
              command: 'bun',
              args: ['./.channels/node_modules/auto-channels/src/adapter/index.ts'],
              env: { AUTO_CHANNELS_ROOT: './.channels' },
            },
          },
        },
        null,
        2,
      )}\n`,
    )

    /*
     * The generated package.json makes .channels/ self-contained: its own
     * dependency on auto-channels (a file: path to the running package,
     * pre-publish -- see init.ts), so the HOST project never needs root-level
     * JS toolchain files.
     */
    const channelsPackage = JSON.parse(readFileSync(join(target, '.channels', 'package.json'), 'utf8'))
    expect(channelsPackage.private).toBe(true)
    expect(channelsPackage.dependencies['auto-channels']).toMatch(/^file:\//)
    // The scaffolded tsconfig names `types: ["bun"]`; a tarball/registry install brings no Bun types.
    expect(channelsPackage.devDependencies).toEqual({ '@types/bun': BUN_TYPES })

    /*
     * The .gitignore keeps runtime/dependency artifacts out of the host's
     * history without touching the host's own .gitignore.
     */
    const gitignore = readFileSync(join(target, '.channels', '.gitignore'), 'utf8')
    expect(gitignore).toBe('node_modules/\nrun/\ndropbox/\n') // regression guard: the inlined lines, byte for byte

    /*
     * The starter template ships disabled (leading underscore), carries the
     * walkthrough a first-time source author needs, and documents the
     * one-line enablement of each builtin -- it's the only scaffolded source,
     * so it's where a consumer learns the builtins exist at all.
     */
    const starter = readFileSync(join(target, '.channels', 'sources', '_starter.ts'), 'utf8')
    expect(starter).toContain('DISABLED')
    expect(starter).toContain('ctx.emit')
    expect(starter).toContain('export default')
    expect(starter).toContain("from 'auto-channels/builtins'")
    for (const builtin of ['webhook({', 'cron(', 'filedrop()']) expect(starter).toContain(builtin)
  })

  test("the starter's guidance is accurate for both hosts", () => {
    const target = freshDir()
    scaffold(target)
    const starter = readFileSync(join(target, '.channels', 'sources', '_starter.ts'), 'utf8')
    expect(starter).toContain('src/builtins') // where the builtin implementations actually live
    expect(starter).toContain('.pi/channels.json') // zero-arg env comes from either host's registration
    expect(starter).toContain('allowedSenders') // webhook still requires a sender gate
    expect(starter).not.toContain('Never use console.log') // a source's stdout is daemon.log, not MCP traffic
  })

  test('never overwrites an existing file, only reports it skipped', () => {
    const target = freshDir()
    mkdirSync(join(target, '.channels'), { recursive: true })
    writeFileSync(join(target, '.channels', 'tsconfig.json'), '{"my": "own"}')
    mkdirSync(join(target, '.channels', 'sources'))
    writeFileSync(join(target, '.channels', 'sources', '_starter.ts'), '// my own starter')

    const { created, skipped } = scaffold(target)

    expect(skipped).toEqual(['.channels/tsconfig.json', '.channels/sources/_starter.ts'])
    expect(readFileSync(join(target, '.channels', 'sources', '_starter.ts'), 'utf8')).toBe('// my own starter')
    expect(created).toContain('.mcp.json')
    // The pre-existing file is byte-for-byte untouched.
    expect(readFileSync(join(target, '.channels', 'tsconfig.json'), 'utf8')).toBe('{"my": "own"}')
  })

  test('running twice is a no-op the second time', () => {
    const target = freshDir()
    scaffold(target)
    const second = scaffold(target)
    expect(second.created).toEqual([])
    expect(second.merged).toEqual([]) // its own output never re-triggers a merge
    expect(second.skipped.sort()).toEqual(EXPECTED_SCAFFOLD)
  })
})

describe('scaffold merges into an already-initialized project', () => {
  test('an existing .mcp.json gains only the auto-channels entry; other servers are preserved', () => {
    const target = freshDir()
    writeFileSync(
      join(target, '.mcp.json'),
      JSON.stringify({ mcpServers: { linear: { command: 'npx', args: ['linear-mcp'] } } }, null, 2),
    )

    const { merged, warnings } = scaffold(target)

    expect(merged).toContain('.mcp.json')
    expect(warnings).toEqual([])
    const mcp = JSON.parse(readFileSync(join(target, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers.linear).toEqual({ command: 'npx', args: ['linear-mcp'] }) // untouched
    expect(mcp.mcpServers['auto-channels'].env.AUTO_CHANNELS_ROOT).toBe('./.channels')
  })

  test('an .mcp.json that already has an auto-channels server is skipped byte-for-byte', () => {
    const target = freshDir()
    /*
     * Deliberately unusual formatting AND a customized auto-channels entry -- a
     * merge that rewrote or "corrected" it would show up here.
     */
    const original = '{"mcpServers":{"auto-channels":{"command":"bun","args":["./elsewhere/adapter.ts"]}}}'
    writeFileSync(join(target, '.mcp.json'), original)

    const { skipped, merged } = scaffold(target)

    expect(skipped).toContain('.mcp.json')
    expect(merged).not.toContain('.mcp.json')
    expect(readFileSync(join(target, '.mcp.json'), 'utf8')).toBe(original)
  })

  test('an unparseable .mcp.json is left untouched and reported as a warning, never clobbered', () => {
    const target = freshDir()
    const broken = '{ this is not json'
    writeFileSync(join(target, '.mcp.json'), broken)

    const { skipped, merged, warnings } = scaffold(target)

    expect(readFileSync(join(target, '.mcp.json'), 'utf8')).toBe(broken)
    expect(skipped).toContain('.mcp.json')
    expect(merged).not.toContain('.mcp.json')
    expect(warnings.some(w => w.includes('.mcp.json'))).toBe(true)
    // The warning carries the entry to add by hand (there is no host template file to point at).
    expect(warnings.some(w => w.includes('adapter/index.ts'))).toBe(true)
  })

  test.each([
    ['.mcp.json', '{"mcpServers": []}'],
    ['.mcp.json', '{"mcpServers": "oops"}'],
    ['.channels/package.json', '{"dependencies": []}'],
    ['.channels/package.json', '{"devDependencies": "oops"}'],
  ])('%s with a non-object container (%s) is left untouched and warned about', (file, original) => {
    const target = freshDir()
    mkdirSync(join(target, '.channels'), { recursive: true })
    writeFileSync(join(target, file), original)

    const { skipped, merged, warnings } = scaffold(target)

    expect(readFileSync(join(target, file), 'utf8')).toBe(original)
    expect(skipped).toContain(file)
    expect(merged).not.toContain(file)
    expect(warnings.some(w => w.startsWith(`${file} already exists but is not a JSON object`))).toBe(true)
  })

  test('an existing .channels/package.json gains only the auto-channels dependency and the Bun types', () => {
    const target = freshDir()
    mkdirSync(join(target, '.channels'), { recursive: true })
    writeFileSync(
      join(target, '.channels', 'package.json'),
      JSON.stringify({ name: 'my-channels', private: true, dependencies: { zod: '^4.0.0' } }, null, 2),
    )

    const { merged } = scaffold(target)

    expect(merged).toContain('.channels/package.json')
    const pkg = JSON.parse(readFileSync(join(target, '.channels', 'package.json'), 'utf8'))
    expect(pkg.name).toBe('my-channels') // consumer's own fields preserved
    expect(pkg.dependencies.zod).toBe('^4.0.0')
    expect(pkg.dependencies['auto-channels']).toMatch(/^file:\//)
    expect(pkg.devDependencies).toEqual({ '@types/bun': BUN_TYPES })
  })

  test('regression guard: an existing @types/bun devDependency is never overwritten', () => {
    const target = freshDir()
    mkdirSync(join(target, '.channels'), { recursive: true })
    writeFileSync(
      join(target, '.channels', 'package.json'),
      JSON.stringify({ dependencies: { 'auto-channels': '^0.1.0' }, devDependencies: { '@types/bun': '1.2.0' } }),
    )

    const { skipped } = scaffold(target)

    expect(skipped).toContain('.channels/package.json')
    const pkg = JSON.parse(readFileSync(join(target, '.channels', 'package.json'), 'utf8'))
    expect(pkg.devDependencies).toEqual({ '@types/bun': '1.2.0' })
  })

  test('an existing .channels/.gitignore is appended with only the missing entries, no duplicates', () => {
    const target = freshDir()
    mkdirSync(join(target, '.channels'), { recursive: true })
    writeFileSync(join(target, '.channels', '.gitignore'), '# mine\nnode_modules/\n*.log\n')

    const { merged } = scaffold(target)

    expect(merged).toContain('.channels/.gitignore')
    const gitignore = readFileSync(join(target, '.channels', '.gitignore'), 'utf8')
    expect(gitignore).toContain('# mine') // existing content preserved, in place
    expect(gitignore).toContain('*.log')
    for (const entry of ['run/', 'dropbox/']) expect(gitignore).toContain(entry)
    expect(gitignore.split('\n').filter(line => line === 'node_modules/')).toHaveLength(1)
  })
})

describe('host flags pick which agent hosts get a registration', () => {
  const PI_ADAPTER_ARGS = ['./.channels/node_modules/auto-channels/src/adapter/index.ts']

  test("hosts: ['pi'] writes .pi/channels.json and no .mcp.json", () => {
    const target = freshDir()
    const { created } = scaffold(target, ['pi'])

    expect(created).toContain('.pi/channels.json')
    expect(created).not.toContain('.mcp.json')
    expect(existsSync(join(target, '.mcp.json'))).toBe(false)
    const pi = JSON.parse(readFileSync(join(target, '.pi', 'channels.json'), 'utf8'))
    // channels.tools' own config shape: channelServers.<name>.{command,args,env}
    expect(pi.channelServers['auto-channels']).toEqual({
      command: 'bun',
      args: PI_ADAPTER_ARGS,
      env: { AUTO_CHANNELS_ROOT: './.channels' },
    })
  })

  test("hosts: ['claude', 'pi'] registers with both; the .channels/ half is identical either way", () => {
    const target = freshDir()
    const { created } = scaffold(target, ['claude', 'pi'])
    expect(created.sort()).toEqual([...EXPECTED_SCAFFOLD, '.pi/channels.json'].sort())
  })

  test('an existing .pi/channels.json gains only the auto-channels entry; other servers are preserved', () => {
    const target = freshDir()
    mkdirSync(join(target, '.pi'))
    writeFileSync(
      join(target, '.pi', 'channels.json'),
      JSON.stringify({ channelServers: { muster: { command: 'muster', args: ['channel'] } } }),
    )

    const { merged } = scaffold(target, ['pi'])

    expect(merged).toContain('.pi/channels.json')
    const pi = JSON.parse(readFileSync(join(target, '.pi', 'channels.json'), 'utf8'))
    expect(pi.channelServers.muster).toEqual({ command: 'muster', args: ['channel'] })
    expect(pi.channelServers['auto-channels'].args).toEqual(PI_ADAPTER_ARGS)
  })
})

describe('cli', () => {
  const CLI = join(REPO_ROOT, 'src', 'cli.ts')

  test('--help exits 0 and names the command and both host flags', () => {
    const help = Bun.spawnSync([process.execPath, CLI, '--help'])
    expect(help.exitCode).toBe(0)
    for (const text of ['init', '--claude', '--pi']) expect(help.stdout.toString()).toContain(text)
  })

  test('an unknown init flag exits 1 before scaffolding anything', () => {
    const target = freshDir()
    const run = Bun.spawnSync([process.execPath, CLI, 'init', '--bogus'], { cwd: target })
    expect(run.exitCode).toBe(1)
    expect(readdirSync(target)).toEqual([])
  })
})

describe('the e2e fixture sources stay genuine builtin activations', () => {
  /*
   * test/e2e/fixtures/sources/ is the shared consumer stand-in most e2e
   * files load (see test/e2e/README.md). Its files must stay one-line
   * builtin activations — never implementation copies creeping back in.
   * e2e_* names are runtime temp fixtures individual
   * tests write and clean up themselves; they're not part of the committed
   * set.
   */
  const FIXTURES_DIR = join(REPO_ROOT, 'test', 'e2e', 'fixtures')

  test('exactly the three activations, each importing from auto-channels/builtins', () => {
    const files = readdirSync(join(FIXTURES_DIR, 'sources'))
      .filter(file => file.endsWith('.ts') && !file.startsWith('e2e_'))
      .sort()
    expect(files).toEqual(['cron.ts', 'filedrop.ts', 'webhook.ts'])
    for (const file of files) {
      expect(readFileSync(join(FIXTURES_DIR, 'sources', file), 'utf8')).toContain("from 'auto-channels/builtins'")
    }
  })
})
