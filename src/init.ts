import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import packageJson from '../package.json' with { type: 'json' }

const TEMPLATES_DIR = join(import.meta.dir, 'templates')

/** The one directory the tool owns in a consumer project. */
export const CHANNELS_DIR = '.channels'

/** The name the adapter is registered under in every host's config — also the `source` on its channel tags. */
export const SERVER_NAME = 'auto-channels'

/** Agent hosts `init` can register the adapter with. */
export const HOSTS = ['claude', 'pi'] as const
export type Host = (typeof HOSTS)[number]

/** The hosts `init` registers with when none is named. */
export const DEFAULT_HOSTS: readonly Host[] = ['claude']

/** The adapter registration every host gets, under SERVER_NAME. */
const ADAPTER_ENTRY = {
  command: 'bun',
  args: ['./.channels/node_modules/auto-channels/src/adapter/index.ts'],
  env: { AUTO_CHANNELS_ROOT: './.channels' },
}

/** What a consumer depends on when `init` doesn't run from a source checkout. */
const GITHUB_DEPENDENCY = 'github:royiro10/auto-channels'

const GITIGNORE_LINES = ['node_modules/', 'run/', 'dropbox/']

/*
 * Where each host looks for its channel-server registrations. Claude Code:
 * `.mcp.json` at the root (it requires it there). pi's channels.tools:
 * `.pi/channels.json` (project scope; its global file is out of bounds for
 * init, which never writes outside the target project).
 */
const HOST_REGISTRATIONS: Record<Host, { target: string; containerKey: string }> = {
  claude: { target: '.mcp.json', containerKey: 'mcpServers' },
  pi: { target: join('.pi', 'channels.json'), containerKey: 'channelServers' },
}

export interface ScaffoldResult {
  created: string[]
  skipped: string[]
  /** Files that existed and gained ONLY the tool's missing entries (see below). */
  merged: string[]
  /** Human-readable problems the scaffold refused to fix by force (e.g. unparseable JSON). */
  warnings: string[]
}

/**
 * Scaffold auto-channels into the consumer project at `targetDir`: one adapter registration per
 * host in `hosts` (`.mcp.json` for Claude Code, `.pi/channels.json` for pi) and a self-contained
 * `.channels/` (package.json, tsconfig.json, .gitignore, and sources/ holding only the disabled
 * `_starter.ts`). Never destructive: a missing file is `created`; an existing one only gains the
 * tool's missing entries (`merged`) or is left byte-identical (`skipped`). Unparseable JSON, a non-object
 * entry container are reported in `warnings`, never touched. A merged JSON file is
 * rewritten with 2-space indentation (key order kept). Does not run `bun install`.
 */
export function scaffold(targetDir: string, hosts: readonly Host[] = DEFAULT_HOSTS): ScaffoldResult {
  const created: string[] = []
  const skipped: string[] = []
  const merged: string[] = []
  const warnings: string[] = []

  /**
   * Create `target` from `create()`, or — when it already exists as valid
   * JSON — let `merge` add the tool's missing entries in place. `merge`
   * mutates the parsed object and returns whether anything was added.
   * `entries` names what to add by hand when the file, or one of its present
   * `containers`, is not a JSON object.
   */
  function upsertJson(
    target: string,
    entries: string,
    containers: readonly string[],
    create: () => unknown,
    merge: (existing: Record<string, unknown>) => boolean,
  ): void {
    const targetPath = join(targetDir, target)
    if (!existsSync(targetPath)) {
      writeFileSync(targetPath, `${JSON.stringify(create(), null, 2)}\n`)
      created.push(target)
      return
    }
    let existing: unknown
    try {
      existing = JSON.parse(readFileSync(targetPath, 'utf8'))
    } catch {
      existing = undefined
    }
    if (!isPlainObject(existing) || containers.some(key => !isPlainObject(existing[key] ?? {}))) {
      warnings.push(`${target} already exists but is not a JSON object -- left untouched; add ${entries} yourself.`)
      skipped.push(target)
      return
    }
    if (!merge(existing)) {
      skipped.push(target)
      return
    }
    writeFileSync(targetPath, `${JSON.stringify(existing, null, 2)}\n`)
    merged.push(target)
  }

  for (const host of hosts) {
    const { target, containerKey } = HOST_REGISTRATIONS[host]
    mkdirSync(dirname(join(targetDir, target)), { recursive: true })
    upsertJson(
      target,
      `"${SERVER_NAME}": ${JSON.stringify(ADAPTER_ENTRY)} under "${containerKey}"`,
      [containerKey],
      () => ({ [containerKey]: { [SERVER_NAME]: ADAPTER_ENTRY } }),
      existing => {
        const servers = (existing[containerKey] ?? {}) as Record<string, unknown>
        if (SERVER_NAME in servers) return false
        servers[SERVER_NAME] = ADAPTER_ENTRY
        existing[containerKey] = servers
        return true
      },
    )
  }

  mkdirSync(join(targetDir, CHANNELS_DIR, 'sources'), { recursive: true })

  // .channels/.gitignore: created, or appended with whichever lines it is missing.
  const gitignore = join(CHANNELS_DIR, '.gitignore')
  const gitignorePath = join(targetDir, gitignore)
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${GITIGNORE_LINES.join('\n')}\n`)
    created.push(gitignore)
  } else {
    const existingText = readFileSync(gitignorePath, 'utf8')
    const existingLines = new Set(existingText.split('\n').map(line => line.trim()))
    const missing = GITIGNORE_LINES.filter(line => !existingLines.has(line))
    if (missing.length === 0) {
      skipped.push(gitignore)
    } else {
      const separator = existingText === '' || existingText.endsWith('\n') ? '' : '\n'
      writeFileSync(gitignorePath, `${existingText}${separator}${missing.join('\n')}\n`)
      merged.push(gitignore)
    }
  }

  for (const file of ['tsconfig.json', join('sources', '_starter.ts')]) {
    const target = join(CHANNELS_DIR, file)
    if (existsSync(join(targetDir, target))) {
      skipped.push(target)
      continue
    }
    copyFileSync(join(TEMPLATES_DIR, 'channels', file), join(targetDir, target))
    created.push(target)
  }

  /*
   * Run from a git checkout (bun link, `bun src/cli.ts`), the consumer depends on that checkout,
   * so local edits are live. Run any other way (bunx from GitHub), the package sits in a temporary
   * download, so the consumer depends on the repo; its lockfile pins the commit.
   */
  // This file lives in src/; the package root (where package.json is) is one up. A bun-linked install is a symlink.
  const packageDir = realpathSync(join(import.meta.dir, '..'))
  const dependency = existsSync(join(packageDir, '.git')) ? `file:${packageDir}` : GITHUB_DEPENDENCY
  // The scaffolded tsconfig names `types: ["bun"]`, and a tarball or registry install brings no Bun types.
  const bunTypes = packageJson.devDependencies['@types/bun']
  upsertJson(
    join(CHANNELS_DIR, 'package.json'),
    `"auto-channels": "${dependency}" under "dependencies" and "@types/bun": "${bunTypes}" under "devDependencies"`,
    ['dependencies', 'devDependencies'],
    () => ({
      name: 'channels',
      private: true,
      description:
        "This project's auto-channels setup: event sources and the tool's own dependencies — see sources/_starter.ts to add a source.",
      dependencies: { 'auto-channels': dependency },
      devDependencies: { '@types/bun': bunTypes },
    }),
    existing => {
      const dependencies = (existing.dependencies ?? {}) as Record<string, unknown>
      const devDependencies = (existing.devDependencies ?? {}) as Record<string, unknown>
      if ('auto-channels' in dependencies && '@types/bun' in devDependencies) return false
      dependencies['auto-channels'] ??= dependency
      devDependencies['@types/bun'] ??= bunTypes
      existing.dependencies = dependencies
      existing.devDependencies = devDependencies
      return true
    },
  )

  return { created, skipped, merged, warnings }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
