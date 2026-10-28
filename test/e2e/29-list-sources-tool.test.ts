/*
 * Pins autochannels_list_sources over the real MCP wire: every loaded source
 * with its name, description, default delivery, and whether this session is
 * subscribed.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { projectFixture, seed, waitFor } from './helpers.ts'

/*
 * Seeds the three shared one-line activation files so the webhook/cron/
 * filedrop builtins load -- this test asserts on their listing.
 */
const project = projectFixture({
  sources: { 'webhook.ts': seed('webhook'), 'cron.ts': seed('cron'), 'filedrop.ts': seed('filedrop') },
})

interface ListedSource {
  name: string
  description: string
  defaultSubscribed: boolean
  subscribed: boolean
}

let client: Client

async function listSources(): Promise<ListedSource[]> {
  const result = await client.callTool({ name: 'autochannels_list_sources', arguments: {} })
  const content = result.content as Array<{ type: string; text: string }>
  const first = content[0]
  if (first?.type !== 'text') throw new Error(`unexpected tool result shape: ${JSON.stringify(result)}`)
  return JSON.parse(first.text) as ListedSource[]
}

beforeAll(async () => {
  const session = project.session()
  client = session.client
  await session.connect()
  await session.ready({ health: true })
}, 20_000)

describe('autochannels_list_sources tool', () => {
  test('lists every loaded source with its real description, all subscribed by default', async () => {
    /*
     * The sources frame is pushed on connect, but source loading itself is
     * async -- poll until all three builtin sources have appeared rather
     * than assuming load order or timing.
     */
    let sources: ListedSource[] = []
    await waitFor(
      async () => {
        sources = await listSources()
        return sources.length >= 3
      },
      10_000,
      'all three builtin sources to appear in autochannels_list_sources',
    )

    const byName = new Map(sources.map(source => [source.name, source]))
    for (const name of ['webhook', 'cron', 'filedrop']) {
      const source = byName.get(name)
      expect(source).toBeDefined()
      /*
       * The description is the file's own real Source.description, not a
       * placeholder -- pin one distinctive phrase per source so a silently
       * empty or wrong-source description fails here.
       */
      expect(source?.description.length).toBeGreaterThan(20)
      expect(source?.defaultSubscribed).toBe(true)
      expect(source?.subscribed).toBe(true)
    }
    expect(byName.get('webhook')?.description).toContain('X-Sender')
    expect(byName.get('cron')?.description).toContain('timer')
    expect(byName.get('filedrop')?.description).toContain('dropbox/')
  })

  test('unsubscribing is reflected in the next listing, and resubscribing restores it', async () => {
    await client.callTool({ name: 'autochannels_unsubscribe', arguments: { source: 'cron' } })
    let sources = await listSources()
    expect(sources.find(source => source.name === 'cron')?.subscribed).toBe(false)
    // Other sources are untouched.
    expect(sources.find(source => source.name === 'webhook')?.subscribed).toBe(true)

    await client.callTool({ name: 'autochannels_subscribe', arguments: { source: 'cron' } })
    sources = await listSources()
    expect(sources.find(source => source.name === 'cron')?.subscribed).toBe(true)
  })
})
