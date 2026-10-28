import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_ATTEMPTS = 50
const token = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
const unique = (path: string) => `${path}.${token}.${Math.random().toString(36).slice(2, 6)}`

function readOwner(lockPath: string): string | undefined {
  try {
    return readFileSync(join(lockPath, 'owner'), 'utf8')
  } catch {
    return undefined
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/*
 * A lock instance is a directory holding `owner` (pid + random token). It is
 * built privately and renamed into place: rename() onto a non-empty directory
 * fails, so acquire is atomic and the lock never exists without its owner.
 * An instance never returns to lockPath once moved, so the path shows a
 * strictly newer instance each time it changes.
 *
 * Stealing a dead owner's instance needs the right to steal THAT instance:
 * mkdir `steal-<owner>` inside it. mkdir succeeds once, and if lockPath/owner
 * still reads <owner> afterwards the marker landed in that very instance
 * (instances never come back), so this contender is its only stealer and its
 * rename() can only move that instance — no put-back, ever.
 * Only the holder touches daemon.sock. Limits: a reused pid makes a dead owner look
 * alive forever, and a stealer killed mid-steal leaves the lock unstealable.
 */
export async function acquireStartupLock(lockPath: string): Promise<'acquired' | 'already-running'> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const staged = unique(lockPath)
    mkdirSync(staged)
    writeFileSync(join(staged, 'owner'), token)
    try {
      renameSync(staged, lockPath)
      return 'acquired'
    } catch (error) {
      rmSync(staged, { recursive: true, force: true })
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
    }
    const seen = readOwner(lockPath)
    if (seen === undefined) continue // moved away between our rename and read
    if (isAlive(Number(seen.split('-')[0]))) return 'already-running'
    try {
      mkdirSync(join(lockPath, `steal-${seen}`))
    } catch {
      await new Promise(resolve => setTimeout(resolve, 5)) // another contender is stealing it
      continue
    }
    if (readOwner(lockPath) !== seen) continue // marker landed in a newer instance: inert
    const taken = unique(lockPath)
    renameSync(lockPath, taken)
    rmSync(taken, { recursive: true, force: true })
  }
  throw new Error(`could not acquire ${lockPath} after ${MAX_ATTEMPTS} attempts`)
}

/** Only the live owner calls this, and nobody steals a live owner's lock. */
export function releaseStartupLock(lockPath: string): void {
  if (readOwner(lockPath) !== token) return
  const taken = unique(lockPath)
  renameSync(lockPath, taken)
  rmSync(taken, { recursive: true, force: true })
}
