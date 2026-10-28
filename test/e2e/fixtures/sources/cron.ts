/*
 * The cron builtin, zero-config: ticks every 60s (CRON_INTERVAL_MS env to
 * change it), or configure inline — cron({ intervalMs: 5_000 }).
 * This one-line file is all it takes to enable a builtin (see _starter.ts).
 */
import { cron } from 'auto-channels/builtins'

export default cron()
