import { createLogger } from '../shared/log.ts'
import type { Source } from '../shared/source.ts'
import { resolveName } from './options.ts'

const DEFAULT_PORT = 8788

/** Options for {@link webhook}. An invalid one fails this source's load (logged by the daemon). */
export interface WebhookOptions {
  /** Source name (the events' `origin` and the subscription key). Two webhooks side by side need distinct names and ports. */
  name?: string
  /** Port to bind on 127.0.0.1. Default: the WEBHOOK_PORT env var (read at start()), else 8788. */
  port?: number
  /** Accept POSTs only to this exact path (anything else gets a 404); must start with `/`. Default: any path. */
  path?: string
  /**
   * REQUIRED, non-empty. Sender IDs (the `X-Sender` header) allowed to inject events; anything
   * else gets a 403. Anything on this machine can reach the listener, a browser tab included,
   * and its events land in the agent's transcript.
   */
  allowedSenders: string[]
}

// A pathname always starts with '/': without one, every POST would 404 with no hint why.
function resolvePath(option: string | undefined): string | undefined {
  if (option === undefined) return undefined
  if (!option.startsWith('/')) {
    throw new Error(`webhook({ path }) must start with "/", got "${option}"`)
  }
  return option
}

function resolvePort(option: number | undefined): number {
  const raw = option ?? process.env.WEBHOOK_PORT
  if (raw === undefined) return DEFAULT_PORT
  const parsed = Number(raw)
  // Bun.serve() silently clamps an out-of-range port to 65535 while the log shows the intended one.
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    const knob = option !== undefined ? 'webhook({ port })' : 'WEBHOOK_PORT'
    throw new Error(`${knob} must be an integer between 1 and 65535, got "${raw}"`)
  }
  return parsed
}

/**
 * A localhost-only HTTP listener: each POST from an allowed `X-Sender` emits its raw body, with
 * `path`, `method` and `sender` in meta; `GET /health` answers `ok`. Gated on sender identity, since
 * an ungated endpoint is a prompt-injection vector. A handler error answers a generic 500.
 *
 *     import { webhook } from 'auto-channels/builtins'
 *     export default webhook({ allowedSenders: ['dev'] })
 */
export function webhook(options: WebhookOptions): Source {
  // Validated at factory time: a listener that silently denies everyone looks healthy and does nothing.
  if (!Array.isArray(options?.allowedSenders) || options.allowedSenders.length === 0) {
    throw new Error(
      "webhook({ allowedSenders }) is required — list the X-Sender identities allowed to inject events, e.g. webhook({ allowedSenders: ['dev'] })",
    )
  }
  const allowedSenders = new Set(options.allowedSenders)
  const name = resolveName(options.name, 'webhook')
  const path = resolvePath(options.path)
  const pathNote = path !== undefined ? `POST ${path} only` : 'POST any path'
  const portNote =
    options.port !== undefined ? `port ${options.port}` : `port ${DEFAULT_PORT} by default, WEBHOOK_PORT to change it`
  return {
    name,
    description:
      `Localhost-only HTTP listener (${pathNote}, ${portNote}). ` +
      `content is the raw request body; meta has path, method, and sender. Gated on the X-Sender header ` +
      `(${options.allowedSenders.length} allowed sender${options.allowedSenders.length === 1 ? '' : 's'}).`,
    start(ctx) {
      const log = createLogger(name)
      const port = resolvePort(options.port)
      const server = Bun.serve({
        port,
        hostname: '127.0.0.1', // localhost-only: nothing outside this machine can POST
        // Without this, Bun's development-mode error page leaks local paths and source into the response.
        error(err) {
          log(`unhandled error in fetch handler: ${String(err)}`)
          return new Response('internal error', { status: 500 })
        },
        async fetch(req) {
          const url = new URL(req.url)
          if (req.method === 'GET' && url.pathname === '/health') return new Response('ok')
          if (path !== undefined && url.pathname !== path) {
            return new Response('not found', { status: 404 })
          }

          const sender = req.headers.get('x-sender') ?? ''
          if (!allowedSenders.has(sender)) return new Response('forbidden', { status: 403 })

          const content = await req.text()
          ctx.emit({ content, meta: { path: url.pathname, method: req.method, sender } })
          return new Response('ok')
        },
      })
      log(`listening on 127.0.0.1:${port}`)
      return () => server.stop(true)
    },
  }
}
