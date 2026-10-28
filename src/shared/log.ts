/** Writes one diagnostic line. */
export type Logger = (message: string) => void

/**
 * A logger that writes `[scope] message` lines to stderr — never stdout, which is
 * the adapter's MCP traffic. In a source, these lines land in the daemon's log.
 */
export function createLogger(scope: string): Logger {
  return message => console.error(`[${scope}] ${message}`)
}
