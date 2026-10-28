/*
 * The webhook builtin: WEBHOOK_PORT validation on the instance (rejected
 * before Bun.serve() is ever called, so those cases bind no port), and the
 * factory's options (precedence, path, required senders, names), which bind
 * one port picked free for this run. Delivery end to end is covered in test/e2e/.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createMockContext, startForTest } from 'auto-channels/shared/testing.ts'
import { webhook as webhookFactory } from '../../../src/builtins/index.ts'

const webhook = webhookFactory({ allowedSenders: ['dev'] })

/*
 * A real bind is unavoidable for the webhook option tests (Bun.serve is the
 * implementation). The port is whatever a port-0 bind got, released at once,
 * so an unrelated local listener can't collide with a fixed choice.
 */
const probe = Bun.serve({ port: 0, fetch: () => new Response() })
const PORT = Number(probe.url.port)
await probe.stop(true)

let stop: (() => void) | undefined

afterEach(() => {
  stop?.()
  stop = undefined
  delete process.env.WEBHOOK_PORT
})

describe('webhook source: WEBHOOK_PORT validation', () => {
  test('rejects a non-integer WEBHOOK_PORT', async () => {
    process.env.WEBHOOK_PORT = 'not-a-number'
    await expect(startForTest(webhook, createMockContext())).rejects.toThrow(/WEBHOOK_PORT/)
  })

  test('rejects a non-positive WEBHOOK_PORT', async () => {
    process.env.WEBHOOK_PORT = '0'
    await expect(startForTest(webhook, createMockContext())).rejects.toThrow(/WEBHOOK_PORT/)
  })

  test('rejects a WEBHOOK_PORT above 65535 instead of silently binding a different port', async () => {
    /*
     * Bun.serve() itself doesn't validate this -- it silently clamps an
     * out-of-range port to 65535 rather than throwing, which would otherwise
     * bind somewhere the operator never asked for with no error at all.
     */
    process.env.WEBHOOK_PORT = '99999999'
    await expect(startForTest(webhook, createMockContext())).rejects.toThrow(/between 1 and 65535/)
  })
})

describe('webhook factory', () => {
  test('port option beats the WEBHOOK_PORT env var', async () => {
    process.env.WEBHOOK_PORT = 'not-even-a-number' // would throw if consulted
    const ctx = createMockContext()
    stop = await startForTest(webhookFactory({ port: PORT, allowedSenders: ['dev'] }), ctx)

    const res = await fetch(`http://127.0.0.1:${PORT}/health`)
    expect(res.status).toBe(200)
  })

  test('an invalid port option fails naming the option, not the env var', async () => {
    await expect(
      startForTest(webhookFactory({ port: 99999999, allowedSenders: ['dev'] }), createMockContext()),
    ).rejects.toThrow(/webhook\(\{ port \}\) must be an integer between 1 and 65535/)
  })

  test('the path option accepts only that path and 404s the rest; sender gating still applies', async () => {
    const ctx = createMockContext()
    stop = await startForTest(webhookFactory({ port: PORT, path: '/ci', allowedSenders: ['dev'] }), ctx)

    const wrongPath = await fetch(`http://127.0.0.1:${PORT}/other`, {
      method: 'POST',
      headers: { 'X-Sender': 'dev' },
      body: 'nope',
    })
    expect(wrongPath.status).toBe(404)

    const stranger = await fetch(`http://127.0.0.1:${PORT}/ci`, {
      method: 'POST',
      headers: { 'X-Sender': 'stranger' },
      body: 'nope',
    })
    expect(stranger.status).toBe(403)

    const ok = await fetch(`http://127.0.0.1:${PORT}/ci`, {
      method: 'POST',
      headers: { 'X-Sender': 'dev' },
      body: 'ci payload',
    })
    expect(ok.status).toBe(200)
    expect(ctx.emitted).toHaveLength(1)
    expect(ctx.emitted[0]?.content).toBe('ci payload')
    expect(ctx.emitted[0]?.meta?.path).toBe('/ci')
  })

  test('name and path show up in the source metadata a session lists', () => {
    const source = webhookFactory({ name: 'deploy-hook', path: '/deploy', allowedSenders: ['dev'] })
    expect(source.name).toBe('deploy-hook')
    expect(source.description).toContain('/deploy')
  })

  test('a path option without a leading slash fails at factory time, not as an unmatchable 404', () => {
    /*
     * URL pathnames always start with '/', so webhook({ path: 'ci', allowedSenders: ['dev'] }) could
     * never match a request — every POST would 404 with no hint why.
     */
    expect(() => webhookFactory({ path: 'ci', allowedSenders: ['dev'] })).toThrow(
      /webhook\(\{ path \}\) must start with "\/"/,
    )
  })

  test('a missing or empty allowedSenders fails at factory time — a reachable deny-all listener is a silent failure', () => {
    // @ts-expect-error — the option is required; the runtime check backs the type
    expect(() => webhookFactory({ port: PORT })).toThrow(/webhook\(\{ allowedSenders \}\) is required/)
    expect(() => webhookFactory({ port: PORT, allowedSenders: [] })).toThrow(
      /webhook\(\{ allowedSenders \}\) is required/,
    )
  })

  test('an empty name option fails at factory time — it is the subscription key and log scope', () => {
    expect(() => webhookFactory({ name: '', allowedSenders: ['dev'] })).toThrow(
      /webhook\(\{ name \}\) must not be empty/,
    )
  })
})

describe("the webhook's error callback", () => {
  test('a throwing handler gets a generic 500 and the thrown message is logged', async () => {
    const logged: string[] = []
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    })
    try {
      const ctx = {
        emitted: [],
        emit() {
          throw new Error('emit boom')
        },
      }
      stop = await startForTest(webhookFactory({ port: PORT, allowedSenders: ['dev'] }), ctx)

      const res = await fetch(`http://127.0.0.1:${PORT}/`, {
        method: 'POST',
        headers: { 'X-Sender': 'dev' },
        body: 'x',
      })
      expect(res.status).toBe(500)
      expect(await res.text()).toBe('internal error') // no dev-mode error page, no local paths
      expect(logged.some(line => line.includes('emit boom'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})
