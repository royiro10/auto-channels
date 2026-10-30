#!/usr/bin/env bun
import { join } from 'node:path'
import packageJson from '../package.json' with { type: 'json' }
import { CHANNELS_DIR, DEFAULT_HOSTS, HOSTS, type Host, SERVER_NAME, scaffold } from './init.ts'

const USAGE = `auto-channels v${packageJson.version}

Usage:
  auto-channels init [--claude] [--pi] [--ref <tag|branch|commit>]
      Scaffold this directory as an auto-channels project, then run bun install
      inside .channels/. Host flags (combinable; default --claude):
        --claude   .mcp.json           (Claude Code)
        --pi       .pi/channels.json   (pi, via the channels.tools extension)
      --ref pins the GitHub repo (e.g. --ref v0.1.0); without it, the project
      follows the latest and its lockfile pins the commit until bun update.
      Safe to re-run: existing files are merged or skipped, never overwritten.
`

/** How to start a session that receives events, per host. */
const NEXT_STEPS: Record<Host, string> = {
  claude: `Claude Code (interactive only -- channels don't reach -p/print mode):\n  claude --dangerously-load-development-channels server:${SERVER_NAME}`,
  pi: 'pi (needs the channels.tools extension once per machine):\n  pi install npm:channels.tools\n  pi',
}

function usageError(message: string): never {
  console.error(`${message}\n`)
  console.log(USAGE)
  process.exit(1)
}

/** Parse `init`'s flags; an unknown flag is an error, never silently ignored. */
function parseInitFlags(flags: string[]): { hosts: readonly Host[]; ref: string | undefined } {
  const hosts: Host[] = []
  let ref: string | undefined
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]
    if (flag === '--ref') {
      ref = flags[++i]
      if (ref === undefined || ref === '' || ref.startsWith('--'))
        usageError('init --ref must name a tag, branch or commit')
      continue
    }
    const host = HOSTS.find(candidate => flag === `--${candidate}`)
    if (host === undefined)
      usageError(`init flag must be one of ${[...HOSTS.map(h => `--${h}`), '--ref'].join(', ')}, got "${flag}"`)
    if (!hosts.includes(host)) hosts.push(host)
  }
  return { hosts: hosts.length > 0 ? hosts : DEFAULT_HOSTS, ref }
}

const [command, ...flags] = process.argv.slice(2)

if (command === 'init') {
  const { hosts, ref } = parseInitFlags(flags)
  const { created, skipped, merged, warnings } = scaffold(process.cwd(), hosts, { ref })
  for (const file of created) console.log(`created  ${file}`)
  for (const file of merged)
    console.log(`merged   ${file} (added the auto-channels entries; everything else preserved)`)
  for (const file of skipped) console.log(`skipped  ${file} (already set up)`)
  for (const warning of warnings) console.warn(`warning  ${warning}`)

  // Inert until installed: every host registration points into .channels/node_modules.
  console.log('\ninstalling dependencies in .channels/ ...')
  const install = Bun.spawnSync(['bun', 'install'], {
    cwd: join(process.cwd(), CHANNELS_DIR),
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (install.exitCode !== 0) {
    console.error(
      '\nbun install failed inside .channels/ -- fix the error above and rerun it there yourself ' +
        '(cd .channels && bun install). The scaffolded files are all in place.',
    )
    process.exit(1)
  }

  console.log(
    created.length > 0 || merged.length > 0
      ? `\nDone. Start a session with:\n${hosts.map(host => `  ${NEXT_STEPS[host].replaceAll('\n', '\n  ')}`).join('\n')}`
      : '\nNothing new to scaffold -- dependencies checked, everything already exists.',
  )
} else {
  console.log(USAGE)
  process.exit(command === undefined || command === 'help' || command === '--help' ? 0 : 1)
}
