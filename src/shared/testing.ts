import { parseEvent } from './protocol.ts'
import type { ChannelEvent, Source, SourceContext, StopFn } from './source.ts'

const POLL_INTERVAL_MS = 20

/** A fake SourceContext for unit-testing one source without a daemon, an adapter or a session. */
export interface MockSourceContext extends SourceContext {
  /** Every event emitted so far, in order. */
  readonly emitted: ChannelEvent[]
}

/** A mock context whose `emit` applies the daemon's event rule: an invalid event throws the daemon's message. */
export function createMockContext(): MockSourceContext {
  const emitted: ChannelEvent[] = []
  return {
    emitted,
    emit(event) {
      // The daemon's own rule, so a source cannot pass here while the real pipeline drops its events.
      emitted.push(parseEvent(event))
    },
  }
}

/** Starts a source against a mock context (a fresh one by default) and returns its stop function, or a no-op. */
export async function startForTest(source: Source, ctx: MockSourceContext = createMockContext()): Promise<StopFn> {
  const stop = await source.start(ctx)
  return stop ?? (() => {})
}

/**
 * Polls `check` every 20 ms until it returns true; throws `timed out waiting for: <label>`
 * after `timeoutMs`, so a failure says what never happened.
 */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  label = 'condition',
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(`timed out waiting for: ${label}`)
}
