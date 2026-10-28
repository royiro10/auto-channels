/*
 * Gating is source-local: the allowed-senders list lives
 * in the webhook activation file itself, so changing who may inject events is
 * an ordinary source edit — applied by hot-reload, no restart of the daemon,
 * the adapter, or this test's MCP client. Both directions are proven in one
 * flow: a stranger is 403'd, becomes allowed after the file edit, then a
 * second edit revokes them and they are 403'd again.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { type ProjectSession, projectFixture, waitFor } from './helpers.ts'

const project = projectFixture({ sources: { 'hook.ts': activation(['dev']) } })

function activation(senders: string[]): string {
  return `import { webhook } from 'auto-channels/builtins'
export default webhook({ allowedSenders: ${JSON.stringify(senders)} })
`
}

async function post(sender: string, body: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${project.port}/`, {
    method: 'POST',
    headers: { 'X-Sender': sender },
    body,
  })
  return res.status
}

/*
 * For polling across a hot-reload: the old webhook stops before the new one
 * binds, so the port is briefly closed — a refused connection means "not
 * applied yet", not a failure (it used to throw straight out of waitFor).
 */
async function statusOrDown(sender: string, body: string): Promise<number | 'down'> {
  try {
    return await post(sender, body)
  } catch {
    return 'down'
  }
}

let session: ProjectSession

beforeAll(async () => {
  session = project.session()
  await session.connect()
  await session.ready({ health: true })
}, 30_000)

describe('changing allowedSenders in the activation file applies via hot-reload', () => {
  test('grant then revoke, no restarts anywhere', async () => {
    // Baseline: 'dev' is in, the newcomer is not.
    expect(await post('dev', 'baseline')).toBe(200)
    expect(await post('newcomer', 'too early')).toBe(403)

    // Grant: edit the activation file — the daemon hot-reloads it, and the
    // rewritten webhook (same port) accepts the newcomer once it's back up.
    project.writeSource('hook.ts', activation(['dev', 'newcomer']))
    await waitFor(async () => (await statusOrDown('newcomer', 'am I in yet?')) === 200, 10_000, 'grant to apply')
    await waitFor(() => session.received.includes('am I in yet?'), 5000, "the newcomer's event to be delivered")

    // Revoke: edit again — the newcomer is out, 'dev' unaffected throughout.
    project.writeSource('hook.ts', activation(['dev']))
    await waitFor(async () => (await statusOrDown('newcomer', 'nope')) === 403, 10_000, 'revoke to apply')
    expect(await post('dev', 'still fine')).toBe(200)
    await waitFor(() => session.received.includes('still fine'), 5000, "dev's event still delivered")
  }, 30_000)
})
