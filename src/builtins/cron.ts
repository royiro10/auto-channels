import { readPositiveInt } from '../shared/config.ts'
import { createLogger } from '../shared/log.ts'
import type { Source } from '../shared/source.ts'
import { resolveName } from './options.ts'

const DEFAULT_INTERVAL_MS = 60_000

/** Options for {@link cron}. An invalid one fails this source's load (logged by the daemon). */
export interface CronOptions {
  /** Source name (the events' `origin` and the subscription key). Pass a distinct one to run two crons side by side. */
  name?: string
  /** Milliseconds between ticks. Default: the CRON_INTERVAL_MS env var (read at start()), else 60s. */
  intervalMs?: number
}

function resolveInterval(option: number | undefined): number {
  if (option === undefined) return readPositiveInt('CRON_INTERVAL_MS', DEFAULT_INTERVAL_MS)
  if (!Number.isInteger(option) || option <= 0) {
    throw new Error(`cron({ intervalMs }) must be a positive integer, got ${option}`)
  }
  return option
}

/**
 * A fixed-interval timer (not cron-expression scheduling) that emits `cron tick at <ISO time>`.
 * A local timer has no sender to gate on. An invalid CRON_INTERVAL_MS fails this source's start.
 *
 *     import { cron } from 'auto-channels/builtins'
 *     export default cron({ intervalMs: 60_000 })
 */
export function cron(options: CronOptions = {}): Source {
  const name = resolveName(options.name, 'cron')
  const intervalNote =
    options.intervalMs !== undefined
      ? `every ${options.intervalMs}ms`
      : `CRON_INTERVAL_MS env, default ${DEFAULT_INTERVAL_MS / 1000}s`
  return {
    name,
    description:
      `Periodic timer, no external input (${intervalNote}). content is a fixed ` +
      "'cron tick at <ISO timestamp>' string.",
    start(ctx) {
      const log = createLogger(name)
      const intervalMs = resolveInterval(options.intervalMs)
      const id = setInterval(() => {
        ctx.emit({ content: `cron tick at ${new Date().toISOString()}` })
      }, intervalMs)
      log(`ticking every ${intervalMs}ms`)
      return () => clearInterval(id)
    },
  }
}
