/*
 * The adapter at its run-function interface: runAdapter over an in-memory MCP
 * transport pair, against a fake daemon (a net server on a temp socket path
 * writing literal NDJSON) or an in-process runDaemon. Env paths are absolute
 * and the cwd input does not exist, so any respawn attempt fails fast instead
 * of starting a real daemon that would steal the socket path.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { type JSONRPCMessage, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { runAdapter } from '../../src/adapter/index.ts'
import { runDaemon } from '../../src/daemon/index.ts'
import { resolveConfig } from '../../src/shared/config.ts'
import type { SourceContext } from '../../src/shared/source.ts'
import { waitFor } from '../../src/shared/testing.ts'

const NO_CWD = '/nonexistent-auto-channels-adapter-test'

const ChannelNotification = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
})
type Notification = z.infer<typeof ChannelNotification>['params']

let tmp: string
let env: Record<string, string>
let logs: string[]
let consoleError: ReturnType<typeof spyOn>
const cleanups: Array<() => unknown> = []

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'adapter-test-'))
  mkdirSync(join(tmp, 'run'))
  mkdirSync(join(tmp, 'src'))
  env = { CHANNEL_RUN_DIR: join(tmp, 'run'), SOURCES_DIR: join(tmp, 'src'), DAEMON_IDLE_SHUTDOWN_MS: '60000' }
  logs = []
  consoleError = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  })
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  consoleError.mockRestore()
  rmSync(tmp, { recursive: true, force: true })
})

const socketPath = () => join(tmp, 'run', 'daemon.sock')
const line = (frame: unknown) => `${JSON.stringify(frame)}\n`

/** A fake daemon on the adapter's socket path; `onConnection` writes its literal NDJSON. */
async function fakeDaemon(onConnection: (socket: Socket) => void): Promise<Server> {
  const server = createServer(onConnection)
  await new Promise<void>(resolve => server.listen(socketPath(), resolve))
  cleanups.push(() => new Promise(resolve => server.close(resolve)))
  return server
}

/** runAdapter plus a connected SDK client; cleanup closes the client first, so the adapter never respawns. */
async function startAdapter(clientName = 'adapter-test') {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const adapter = runAdapter(serverSide, { env, cwd: NO_CWD })
  const client = new Client({ name: clientName, version: '0' }, { capabilities: {} })
  const notifications: Notification[] = []
  client.setNotificationHandler(ChannelNotification, async ({ params }) => {
    notifications.push(params)
  })
  await client.connect(clientSide)
  cleanups.push(async () => {
    await client.close()
    await adapter
  })
  return { client, adapter, notifications }
}

interface Row {
  name: string
  description: string
  defaultSubscribed: boolean
  subscribed: boolean
}

async function listSources(client: Client): Promise<Row[]> {
  const result = (await client.callTool({ name: 'autochannels_list_sources', arguments: {} })) as {
    content: Array<{ text?: string }>
  }
  return JSON.parse(result.content[0]?.text ?? '[]')
}

const SOURCE = { name: 'src', description: 'adapter.test fixture', file: 'src.ts', defaultSubscribed: true }

test('regression guard: runAdapter lists the three tools and mirrors a sources frame', async () => {
  await fakeDaemon(socket => socket.write(line({ type: 'sources', sources: [SOURCE] })))
  const { client } = await startAdapter()

  const { tools } = await client.listTools()
  expect(tools.map(tool => tool.name).sort()).toEqual([
    'autochannels_list_sources',
    'autochannels_subscribe',
    'autochannels_unsubscribe',
  ])
  await waitFor(async () => (await listSources(client)).length > 0, 5000, 'the mirrored sources frame')
  expect(await listSources(client)).toEqual([
    { name: 'src', description: 'adapter.test fixture', defaultSubscribed: true, subscribed: true },
  ])
})

test('regression guard: an in-process runDaemon + runAdapter round trip delivers an event', async () => {
  writeFileSync(
    join(tmp, 'src', 'probe.ts'),
    `export default {
  name: 'probe',
  description: 'adapter.test fixture',
  start(ctx) {
    globalThis.__roundTrip = ctx
  },
}
`,
  )
  const config = resolveConfig(env, tmp)
  const controller = new AbortController()
  const daemon = runDaemon(config, controller.signal)
  cleanups.push(() => controller.abort('test cleanup'))
  await waitFor(() => existsSync(config.pidPath), 5000, 'the daemon listening')

  const { client, adapter, notifications } = await startAdapter()
  await waitFor(async () => (await listSources(client)).some(s => s.name === 'probe'), 5000, 'probe listed')
  const ctx = (globalThis as { __roundTrip?: SourceContext }).__roundTrip
  ctx?.emit({ content: 'hello', meta: { k: 'v' } })
  await waitFor(() => notifications.some(n => n.content === 'hello'), 5000, 'the event notification')
  expect(notifications.find(n => n.content === 'hello')?.meta).toEqual({ origin: 'probe', k: 'v' })

  await client.close()
  await adapter // the adapter first, so it never respawns the daemon
  controller.abort('SIGTERM')
  expect(await daemon).toBe('stopped')
})

/*
 * The link connects (and spawns) eagerly but hands nothing to MCP
 * before `initialized`. The client side is a raw transport, started first,
 * that records every server message; the fake daemon writes a sources frame
 * and an event for `src` the moment the adapter connects.
 */
describe('nothing reaches the host before MCP initialization', () => {
  async function eagerDaemon(): Promise<{ written: Promise<void> }> {
    let delivered!: () => void
    const written = new Promise<void>(resolve => {
      delivered = resolve
    })
    await fakeDaemon(socket => {
      socket.write(line({ type: 'sources', sources: [SOURCE] }))
      socket.write(line({ type: 'event', source: 'src', content: 'hello' }), () => delivered())
    })
    return { written }
  }

  async function rawAdapter() {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const messages: JSONRPCMessage[] = []
    clientSide.onmessage = message => {
      messages.push(message)
    }
    await clientSide.start()
    const adapter = runAdapter(serverSide, { env, cwd: NO_CWD })
    cleanups.push(async () => {
      await clientSide.close()
      await adapter
    })
    const channel = () =>
      messages.flatMap(m =>
        'method' in m && m.method === 'notifications/claude/channel' ? [m.params as Notification] : [],
      )
    return { clientSide, messages, channel }
  }

  // The frames are already in the adapter's socket buffer; an unpaused socket would forward them within milliseconds.
  const NEGATIVE_WINDOW_MS = 300

  test("(a) before initialize, a connected daemon's frames are not forwarded", async () => {
    const { written } = await eagerDaemon()
    const { channel } = await rawAdapter()
    await written
    await new Promise(resolve => setTimeout(resolve, NEGATIVE_WINDOW_MS))
    expect(channel()).toEqual([])
  })

  test('(b) between initialize and initialized nothing is forwarded; after initialized the buffered event is, host-shaped', async () => {
    const { written } = await eagerDaemon()
    const { clientSide, messages, channel } = await rawAdapter()
    await clientSide.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'channels.tools', version: '0' },
      },
    })
    await waitFor(() => messages.some(m => 'id' in m && m.id === 1), 5000, 'the initialize response')
    await written
    await new Promise(resolve => setTimeout(resolve, NEGATIVE_WINDOW_MS))
    expect(channel()).toEqual([])

    await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const event = () => channel().find(n => n.meta?.origin === 'src')
    await waitFor(() => event() !== undefined, 5000, 'the buffered event notification')
    expect(event()?.content).toStartWith('[src] ')
  })

  test('regression guard: a transport whose start() rejects rejects runAdapter, and the link is closed', async () => {
    let connections = 0
    let closes = 0
    await fakeDaemon(socket => {
      connections++
      socket.on('close', () => closes++)
    })
    const [, serverSide] = InMemoryTransport.createLinkedPair()
    serverSide.start = () => Promise.reject(new Error('transport start failed'))
    await expect(runAdapter(serverSide, { env, cwd: NO_CWD })).rejects.toThrow('transport start failed')
    await waitFor(() => connections === 1 && closes === 1, 5000, 'the fake daemon to see its connection closed')
  })
})

test('an MCP protocol error is logged', async () => {
  await fakeDaemon(() => {})
  const { client } = await startAdapter()
  await client.transport?.send({ jsonrpc: '2.0', id: 999, result: {} })
  await waitFor(() => logs.some(l => l.startsWith('[adapter] MCP error')), 5000, 'the MCP error line')
})

test('a muted source is vetoed while its replay is in flight', async () => {
  const sockets: Socket[] = []
  await fakeDaemon(socket => {
    sockets.push(socket)
    if (sockets.length === 1) return
    // The reconnect: events the daemon still filters by the old (empty) intent, written before reading the replay.
    for (let i = 0; i < 20; i++) socket.write(line({ type: 'event', source: 'ticker', content: `tick ${i}` }))
    socket.write(line({ type: 'event', source: 'other', content: 'other' }))
  })
  const { client, notifications } = await startAdapter()
  await waitFor(() => sockets.length === 1, 5000, 'the first connection')
  await client.callTool({ name: 'autochannels_unsubscribe', arguments: { source: 'ticker' } })
  sockets[0]?.destroy()

  await waitFor(() => notifications.some(n => n.content === 'other'), 10_000, 'the reconnect and its other event')
  expect(notifications.filter(n => n.meta?.origin === 'ticker')).toEqual([])
}, 15_000)

test('origin is assigned last: a raw frame cannot spoof it', async () => {
  await fakeDaemon(socket =>
    socket.write(line({ type: 'event', source: 'real', content: 'x', meta: { origin: 'spoof', k: 'v' } })),
  )
  const { notifications } = await startAdapter()
  await waitFor(() => notifications.some(n => n.content === 'x'), 5000, 'the event notification')
  const meta = notifications.find(n => n.content === 'x')?.meta
  expect(meta?.origin).toBe('real')
  expect(meta?.k).toBe('v')
})

/*
 * No readiness marker. Barrier: onConnect runs before the
 * connection's first frame is handled, and notifications reach the client
 * ahead of a later tool response (the waitForSource ordering), so once the
 * mirror shows a connection's sources frame, anything onConnect sent is here.
 */
test.each(['claude-code', 'channels.tools'])(
  'no channel notification is sent on connect or on reconnect, for a %s client',
  async clientName => {
    const sockets: Socket[] = []
    await fakeDaemon(socket => {
      sockets.push(socket)
      socket.write(line({ type: 'sources', sources: [{ ...SOURCE, name: `gen${sockets.length}` }] }))
    })
    const { client, notifications } = await startAdapter(clientName)
    const listed = async (name: string) => (await listSources(client)).some(s => s.name === name)
    await waitFor(() => listed('gen1'), 5000, 'the first connection')
    sockets[0]?.destroy()
    await waitFor(() => listed('gen2'), 10_000, 'the reconnect')
    expect(notifications).toEqual([])
  },
  15_000,
)
