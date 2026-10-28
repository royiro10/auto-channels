/*
 * Pins the adapter's exact MCP contract: capabilities are exactly
 * `{ experimental: { 'claude/channel': {} }, tools: {} }` plus an instructions
 * string. The tools manage what this session receives (list, subscribe,
 * unsubscribe); events stay one-way, with no reply tools.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { projectFixture, seed } from './helpers.ts'

const project = projectFixture({
  sources: { 'webhook.ts': seed('webhook'), 'cron.ts': seed('cron'), 'filedrop.ts': seed('filedrop') },
})

let client: Client

beforeAll(async () => {
  const session = project.session()
  client = session.client
  await session.connect()
  await session.ready({ health: true })
}, 20_000)

describe('MCP capability/instructions contract for the channel adapter', () => {
  test('declares the claude/channel experimental capability (presence registers the notification listener)', () => {
    const caps = client.getServerCapabilities()
    const channelCap = caps?.experimental?.['claude/channel']
    expect(channelCap).toBeDefined()
    expect(typeof channelCap).toBe('object')
  })

  test('declares exactly the channel + tools capabilities, nothing else', () => {
    const caps = client.getServerCapabilities()
    expect(caps?.prompts).toBeUndefined()
    expect(caps?.resources).toBeUndefined()
    expect(caps?.logging).toBeUndefined()
    /*
     * The full capability object should be *exactly* this shape — guards
     * against an unrelated capability being added later without this test
     * being updated.
     */
    expect(caps).toEqual({ experimental: { 'claude/channel': {} }, tools: {} })
  })

  test('tools/list returns exactly the three subscription-registry tools, no reply tool', async () => {
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.name).sort()).toEqual([
      'autochannels_list_sources',
      'autochannels_subscribe',
      'autochannels_unsubscribe',
    ])
    /*
     * Events stay one-way: nothing here lets the session send anything back
     * through the channel, only manage what it receives.
     */
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(0)
    }
    const bySchema = Object.fromEntries(tools.map(tool => [tool.name, tool.inputSchema]))
    expect(bySchema.autochannels_list_sources?.properties).toEqual({})
    expect(bySchema.autochannels_subscribe?.required).toEqual(['source'])
    expect(bySchema.autochannels_unsubscribe?.required).toEqual(['source'])
  })

  test('instructions were passed to the Server constructor and are exposed via getInstructions()', () => {
    const instructions = client.getInstructions()
    expect(typeof instructions).toBe('string')
    expect(instructions?.length).toBeGreaterThan(0)
    expect(instructions?.toLowerCase()).toContain('channel')
    // The instructions must actually tell the model its subscription tools exist.
    expect(instructions).toContain('autochannels_list_sources')
  })

  test('server identifies itself as name "auto-channels" with the package\'s own version', () => {
    const version = client.getServerVersion()
    expect(version?.name).toBe('auto-channels')
    /*
     * Compared against the same package.json the adapter reads, so a release
     * bump can't leave this asserting a stale hardcoded number.
     */
    const packageJson = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8')) as {
      version: string
    }
    expect(version?.version).toBe(packageJson.version)
  })
})
