/*
 * Pins opt-in delivery: a `defaultSubscribed: false` source runs and is
 * listed for every session, but its events reach only sessions that
 * subscribed. Delivery defaults are per emitting instance, captured before
 * start(), including during startup, reload and duplicate names.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  listSourceNames,
  type ProjectSession,
  projectFixture,
  type ReceivedEvent,
  seed,
  waitFor,
  waitForSource,
} from './helpers.ts'

const project = projectFixture({
  sources: { 'webhook.ts': seed('webhook'), 'cron.ts': seed('cron'), 'filedrop.ts': seed('filedrop') },
})
const TICK_CONTENT = 'e2e-31 opt-in tick'

let client: Client
let received: ReceivedEvent[]

function tickCount(): number {
  return received.filter(event => event.content === TICK_CONTENT).length
}

beforeAll(async () => {
  const session = project.session()
  client = session.client
  received = session.notifications
  await session.connect()
  await session.ready({ health: true })
}, 20_000)

describe('a defaultSubscribed: false source delivers nothing until explicitly subscribed', () => {
  test('the source loads and appears in autochannels_list_sources, but its ticks never arrive unsubscribed', async () => {
    project.writeSource(
      'e2e_31_optin.ts',
      `
import type { Source } from 'auto-channels/shared/source.ts'
const optin: Source = {
  name: 'e2e-31-optin',
  description: 'e2e fixture: opt-in ticking source',
  defaultSubscribed: false,
  start(ctx) {
    const id = setInterval(() => ctx.emit({ content: '${TICK_CONTENT}' }), 150)
    return () => clearInterval(id)
  },
}
export default optin
`,
    )

    /*
     * Loaded and visible: the registry knows it (and reports it opt-in) even
     * though nothing is delivered yet.
     */
    await waitFor(
      async () => {
        const result = await client.callTool({ name: 'autochannels_list_sources', arguments: {} })
        const content = result.content as Array<{ type: string; text: string }>
        const listing = JSON.parse(content[0]?.text ?? '[]') as Array<{
          name: string
          defaultSubscribed: boolean
          subscribed: boolean
        }>
        const optin = listing.find(source => source.name === 'e2e-31-optin')
        return optin !== undefined && optin.defaultSubscribed === false && optin.subscribed === false
      },
      10_000,
      'the opt-in source to appear in autochannels_list_sources as loaded-but-unsubscribed',
    )

    /*
     * The source has been running (150ms interval) at least since autochannels_list_sources
     * saw it -- give it several more tick intervals and assert none arrived.
     */
    await new Promise(resolve => setTimeout(resolve, 800))
    expect(tickCount()).toBe(0)
  })

  test('subscribing starts delivery; unsubscribing stops it again', async () => {
    await client.callTool({ name: 'autochannels_subscribe', arguments: { source: 'e2e-31-optin' } })
    await waitFor(() => tickCount() >= 2, 5000, 'ticks to start arriving after subscribe')

    const log = project.logCursor()
    await client.callTool({ name: 'autochannels_unsubscribe', arguments: { source: 'e2e-31-optin' } })
    /*
     * The adapter's mute veto runs inside the tool handler, so every tick it
     * forwarded before is ahead of the tool response on stdio: the count at
     * the tool's return is final. The daemon's own log line proves
     * the frame reached it; then several tick intervals must add nothing.
     */
    const countAfterUnsubscribe = tickCount()
    await waitFor(() => log.since().includes('-[e2e-31-optin]'), 5000, 'daemon to apply the unsubscribe')
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(tickCount()).toBe(countAfterUnsubscribe)
  })
})

/*
 * A source's delivery default is captured per instance before its
 * start(), not looked up by name in the successful-load registry — so an
 * opt-in source is opt-in from its first emit (inside start(), across a
 * reload, from a retired instance), and same-name instances each follow
 * their own declaration. `plain` never states an intent; `explicit`
 * does, and doubles as proof that the events in question really happened.
 */
describe('delivery defaults are per instance, captured before start()', () => {
  const p = projectFixture()
  let plain: ProjectSession
  let explicit: ProjectSession

  function source(
    name: string,
    body: string,
    { defaultSubscribed = true, description = 'e2e-31 per-instance default fixture' } = {},
  ) {
    return `import { existsSync } from 'node:fs'
import type { Source } from 'auto-channels/shared/source.ts'
const s: Source = {
  name: ${JSON.stringify(name)},
  description: ${JSON.stringify(description)},
  defaultSubscribed: ${defaultSubscribed},
  async start(ctx) {
    ${body}
  },
}
export default s
`
  }
  // A 100 ms ticker; `registerLast` makes start() take 200 ms longer, so its instance registers after a sibling's.
  const ticker = (content: string, registerLast = false) =>
    `const id = setInterval(() => ctx.emit({ content: ${JSON.stringify(content)} }), 100)
    ${registerLast ? 'await new Promise(resolve => setTimeout(resolve, 200))' : ''}
    return () => clearInterval(id)`
  const count = (session: ProjectSession, content: string) => session.received.filter(c => c === content).length

  async function intent(tool: 'autochannels_subscribe' | 'autochannels_unsubscribe', name: string): Promise<void> {
    const log = p.logCursor()
    await explicit.client.callTool({ name: tool, arguments: { source: name } })
    await waitFor(() => log.since().includes('session explicit subscriptions:'), 5000, `the daemon to apply ${tool}`)
  }

  // The registry as `plain` sees it, with descriptions: a delivery barrier on plain's own socket.
  async function listed(name: string): Promise<Array<{ name: string; description: string }>> {
    const result = (await plain.client.callTool({ name: 'autochannels_list_sources', arguments: {} })) as {
      content: Array<{ text?: string }>
    }
    const all = JSON.parse(result.content[0]?.text ?? '[]') as Array<{ name: string; description: string }>
    return all.filter(info => info.name === name)
  }

  beforeAll(async () => {
    plain = p.session({ name: 'plain' })
    explicit = p.session({ name: 'explicit', env: { AGENT_SESSION_ID: 'explicit' } })
    await plain.connect()
    await explicit.connect()
    await plain.ready()
    await explicit.ready()
  }, 30_000)

  test('(a)+(c) an opt-in start-time emit reaches a session subscribed before the file existed, never the default one', async () => {
    await intent('autochannels_subscribe', 'b37-sync-optin')
    p.writeSource(
      'b37_sync_optin.ts',
      source('b37-sync-optin', "ctx.emit({ content: 'sync-optin start' })", { defaultSubscribed: false }),
    )
    await waitFor(() => count(explicit, 'sync-optin start') === 1, 10_000, 'the explicit subscriber to get it')
    await waitForSource(plain.client, 'b37-sync-optin', true) // the registry frame trails the start-time emit
    expect(count(plain, 'sync-optin start')).toBe(0)
  }, 20_000)

  test('(b) the same holds after an edit reloads it', async () => {
    p.writeSource(
      'b37_sync_optin.ts',
      source('b37-sync-optin', "ctx.emit({ content: 'sync-optin v2 start' })", {
        defaultSubscribed: false,
        description: 'v2',
      }),
    )
    await waitFor(() => count(explicit, 'sync-optin v2 start') === 1, 10_000, 'the explicit subscriber to get v2')
    await waitFor(
      async () => (await listed('b37-sync-optin'))[0]?.description === 'v2',
      10_000,
      'plain to see v2 registered',
    )
    expect(count(plain, 'sync-optin v2 start')).toBe(0)
    p.removeSource('b37_sync_optin.ts')
    await waitForSource(plain.client, 'b37-sync-optin', false)
  }, 20_000)

  test('(c) a session that unsubscribed from a default source before it existed never gets its start-time emit', async () => {
    await intent('autochannels_unsubscribe', 'b37-sync-default')
    p.writeSource('b37_sync_default.ts', source('b37-sync-default', "ctx.emit({ content: 'sync-default start' })"))
    await waitFor(() => count(plain, 'sync-default start') === 1, 10_000, 'the default session to get it')
    await waitForSource(explicit.client, 'b37-sync-default', true)
    expect(count(explicit, 'sync-default start')).toBe(0)
    p.removeSource('b37_sync_default.ts')
    await waitForSource(plain.client, 'b37-sync-default', false)
  }, 20_000)

  test('(d) a retired opt-in instance never reaches the default session after an edit makes the name default', async () => {
    const marker = join(p.root, 'b37-v1-may-stop')
    await intent('autochannels_subscribe', 'b37-retired')
    // v1's stop() deliberately leaves its ticker running until the marker file appears.
    p.writeSource(
      'b37_retired.ts',
      source(
        'b37-retired',
        `const id = setInterval(() => existsSync(${JSON.stringify(marker)}) ? clearInterval(id) : ctx.emit({ content: 'v1-tick' }), 100)
    return () => {}`,
        { defaultSubscribed: false },
      ),
    )
    await waitFor(() => count(explicit, 'v1-tick') >= 1, 10_000, 'v1 ticking')
    p.writeSource('b37_retired.ts', source('b37-retired', ticker('v2-tick')))
    await waitFor(() => count(plain, 'v2-tick') >= 1, 10_000, 'the default session to get v2')
    const v1 = count(explicit, 'v1-tick')
    await waitFor(() => count(explicit, 'v1-tick') >= v1 + 3, 5000, 'the retired v1 still ticking')
    const v2 = count(plain, 'v2-tick')
    await waitFor(() => count(plain, 'v2-tick') >= v2 + 2, 5000, 'more v2 ticks on the default session') // trails any v1 tick
    expect(count(plain, 'v1-tick')).toBe(0)
    writeFileSync(marker, '')
    p.removeSource('b37_retired.ts')
    await waitForSource(plain.client, 'b37-retired', false)
  }, 30_000)

  for (const last of ['a', 'b'] as const) {
    for (const removed of ['b', 'a'] as const) {
      test(`(e) duplicate names: ${last}.ts registers last, then ${removed}.ts is removed`, async () => {
        await intent('autochannels_subscribe', 'b37-dup')
        p.writeSource('b37_dup_a.ts', source('b37-dup', ticker('dup-a tick', last === 'a')))
        p.writeSource(
          'b37_dup_b.ts',
          source('b37-dup', ticker('dup-b tick', last === 'b'), { defaultSubscribed: false }),
        )
        const dups = async () => (await listSourceNames(plain.client)).filter(name => name === 'b37-dup').length
        await waitFor(async () => (await dups()) === 2, 10_000, 'both instances registered')
        const b = count(explicit, 'dup-b tick')
        await waitFor(() => count(explicit, 'dup-b tick') >= b + 3, 5000, "b's ticks flowing")
        const a = count(plain, 'dup-a tick')
        await waitFor(() => count(plain, 'dup-a tick') >= a + 3, 5000, "a's ticks on the default session") // trails any b tick
        expect(count(plain, 'dup-b tick')).toBe(0)

        p.removeSource(`b37_dup_${removed}.ts`)
        await waitFor(async () => (await dups()) === 1, 10_000, `${removed}.ts retired`)
        if (removed === 'b') {
          const after = count(plain, 'dup-a tick')
          await waitFor(() => count(plain, 'dup-a tick') >= after + 3, 5000, "a's ticks still arriving")
        } else {
          const after = count(explicit, 'dup-b tick')
          await waitFor(() => count(explicit, 'dup-b tick') >= after + 3, 5000, "b's ticks still flowing")
        }
        p.removeSource(`b37_dup_${removed === 'b' ? 'a' : 'b'}.ts`)
        await waitForSource(plain.client, 'b37-dup', false) // trails every tick either instance sent plain
        expect(count(plain, 'dup-b tick')).toBe(0)
      }, 30_000)
    }
  }
})
