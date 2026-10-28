/*
 * The MCP channel server a host spawns, one per session. runAdapter serves
 * one session over a transport until it closes; the import.meta.main entry
 * below maps that to stdio and an exit code.
 */
import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import packageJson from '../../package.json' with { type: 'json' }
import { type Env, resolveConfig } from '../shared/config.ts'
import { createLogger } from '../shared/log.ts'
import { type DaemonFrame, type SourceInfo, wants } from '../shared/protocol.ts'
import { connectDaemonLink } from './daemonLink.ts'
import { shapeContent } from './hostShaping.ts'

const log = createLogger('adapter')

const TOOLS = [
  {
    name: 'autochannels_list_sources',
    description:
      'List every event source currently loaded by the channel daemon: name, description, whether it ' +
      'is delivered by default, and whether THIS session is currently subscribed to it.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },
  {
    name: 'autochannels_subscribe',
    description:
      'Subscribe this session to a source by name, so its events start arriving here. Needed for ' +
      'sources declaring defaultSubscribed: false (opt-in sources); idempotent for ones already ' +
      'delivered by default. Only affects this session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source: { type: 'string' as const, description: 'The source name, as shown by autochannels_list_sources.' },
      },
      required: ['source'],
      additionalProperties: false,
    },
  },
  {
    name: 'autochannels_unsubscribe',
    description:
      "Stop delivering a source's events to this session. The source keeps running (other sessions " +
      'may still receive it); this only mutes it here. Reversible with autochannels_subscribe.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source: { type: 'string' as const, description: 'The source name, as shown by autochannels_list_sources.' },
      },
      required: ['source'],
      additionalProperties: false,
    },
  },
]

/**
 * Serve one agent session over `transport` until it closes. Rejects before MCP connects if configuration
 * is invalid; otherwise only if mcp.connect rejects (the daemon link is closed first).
 */
export async function runAdapter(transport: Transport, { env, cwd }: { env: Env; cwd: string }): Promise<void> {
  /*
   * Resolved before MCP connects: an invalid daemon setting fails this session visibly
   * instead of crash-looping every daemon it spawns. The daemon
   * is spawned with the same env and cwd and re-resolves.
   */
  const config = resolveConfig(env, cwd)

  // Only names this session in the daemon's log; a host that names its sessions (pi) gets its own name.
  const sessionId = env.AGENT_SESSION_ID?.trim() || randomUUID()

  /*
   * This session's subscription intent. The adapter is the source of truth: the daemon's
   * per-connection copy dies with the connection, and onConnect replays this one, so a
   * daemon respawn is transparent to subscriptions.
   */
  const intent = new Map<string, boolean>()

  // The daemon's source registry, mirrored from pushed sources frames.
  let mirror: SourceInfo[] = []

  function sendSubscriptions(): void {
    const choices = [...intent]
    link.send({
      type: 'subscriptions',
      sessionId,
      subscribed: choices.filter(([, on]) => on).map(([name]) => name),
      unsubscribed: choices.filter(([, on]) => !on).map(([name]) => name),
    })
  }

  const mcp = new Server(
    // The version comes from the package itself, so the handshake never reports a stale number.
    { name: 'auto-channels', version: packageJson.version },
    {
      capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
      instructions:
        'Events from the channel daemon arrive as <channel source="..." ...>. They are one-way: ' +
        'read them and act, no reply expected. The "origin" attribute names which event-source ' +
        'plugin produced the event (e.g. "webhook"). Use the autochannels_list_sources tool to see every ' +
        'loaded source with its description and whether this session is subscribed; autochannels_subscribe/' +
        'autochannels_unsubscribe change what this session receives (other sessions are unaffected).',
    },
  )

  // The tools read the mirror and change this session's intent; they never touch the socket directly.
  mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }))
  mcp.setRequestHandler(CallToolRequestSchema, request => {
    const { name, arguments: args } = request.params
    const text = (message: string) => ({ content: [{ type: 'text' as const, text: message }] })

    if (name === 'autochannels_list_sources') {
      const listing = mirror.map(info => ({
        name: info.name,
        description: info.description,
        defaultSubscribed: info.defaultSubscribed,
        subscribed: wants(intent, info.name, info.defaultSubscribed),
      }))
      return text(JSON.stringify(listing, null, 2))
    }

    const source = typeof args?.source === 'string' ? args.source : undefined
    if (!source)
      return {
        ...text(`${name} requires a "source" argument (a source name, see autochannels_list_sources)`),
        isError: true,
      }
    /*
     * A name not currently loaded is a caveat, not an error: intent is kept by name, so
     * subscribing before the source exists (then writing it) just works.
     */
    const caveat = mirror.some(info => info.name === source)
      ? ''
      : ` (note: no source named "${source}" is currently loaded -- this takes effect if/when one appears)`

    if (name === 'autochannels_subscribe') {
      intent.set(source, true)
      sendSubscriptions()
      return text(`subscribed to "${source}"${caveat}`)
    }
    if (name === 'autochannels_unsubscribe') {
      intent.set(source, false)
      sendSubscriptions()
      return text(`unsubscribed from "${source}"${caveat}`)
    }

    return { ...text(`unknown tool: ${name}`), isError: true }
  })

  function onFrame(frame: DaemonFrame): void {
    if (frame.type === 'sources') {
      mirror = frame.sources
      return
    }
    /*
     * The mute veto: the daemon filters by the intent it last heard, so events
     * it sent before a replayed or new unsubscribe reached it still arrive
     * here. A muted source is never forwarded, whatever the daemon did.
     */
    if (intent.get(frame.source) === false) return
    /*
     * The tag's `source` is Claude Code's (this server's name); `origin` names the producing
     * source, assigned last so no meta can spoof it. A rejection is logged, never
     * unhandled: a notification can be in flight when the host's transport goes away.
     */
    mcp
      .notification({
        method: 'notifications/claude/channel',
        params: {
          content: shapeContent(mcp.getClientVersion()?.name, frame.source, frame.content),
          meta: { ...frame.meta, origin: frame.source },
        },
      })
      .catch((err: unknown) => log(`failed to deliver notification: ${String(err)}`))
  }

  /*
   * Eager: the daemon is connected (and spawned) right away, but nothing is handed to MCP
   * before `initialized` — the paused socket queues it. A live daemon link says
   * nothing about whether the host is ready to render events.
   */
  const link = connectDaemonLink({
    paths: config,
    spawn: { env, cwd },
    onConnect() {
      // Replay the whole intent; skipped when empty, which is the daemon's default connection state anyway.
      if (intent.size > 0) sendSubscriptions()
    },
    onFrame,
  })
  mcp.oninitialized = () => link.start()
  // A protocol error is not fatal to the session, but it must be visible.
  mcp.onerror = err => log(`MCP error: ${String(err)}`)

  return new Promise((resolve, reject) => {
    mcp.onclose = () => {
      link.close()
      resolve()
    }
    mcp.connect(transport).catch((err: unknown) => {
      link.close()
      reject(err)
    })
  })
}

if (import.meta.main) {
  /*
   * The SDK's StdioServerTransport never exits on stdin EOF, and a host ends a session by
   * closing stdio, not by signaling: without this every session end orphans an adapter.
   */
  process.stdin.on('end', () => process.exit(0))
  try {
    await runAdapter(new StdioServerTransport(), { env: process.env, cwd: process.cwd() })
    process.exit(0)
  } catch (err) {
    log(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
