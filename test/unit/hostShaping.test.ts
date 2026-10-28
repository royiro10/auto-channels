/*
 * The host-specific content shaping (adapter/hostShaping.ts) — pure, so every
 * edge of the channels.tools guidance-sentinel escape is enumerated here
 * rather than through a real adapter (e2e-37 covers the wiring). The first
 * argument is the MCP client's `clientInfo.name`.
 */
import { describe, expect, test } from 'bun:test'
import { shapeContent } from '../../src/adapter/hostShaping.ts'

/** channels.tools' own split rule (envelope.ts splitGuidance), reproduced to prove the escape defeats it. */
function channelsToolsBody(content: string): string {
  const at = content.indexOf('\n\n---\n')
  return at < 0 ? content : content.slice(0, at)
}

describe('shapeContent', () => {
  test('channels.tools is recognized by its clientInfo name', () => {
    expect(shapeContent('channels.tools', 'webhook', 'x')).toBe('[webhook] x')
  })

  test('anything else — including not-yet-initialized — is Claude Code: content verbatim, sentinel and all', () => {
    const content = 'intro\n\n---\nrest'
    expect(shapeContent('claude-code', 'webhook', content)).toBe(content)
    expect(shapeContent('e2e-test-client', 'webhook', content)).toBe(content)
    expect(shapeContent(undefined, 'webhook', content)).toBe(content)
  })

  test('channels.tools gets the origin as a first-line prefix', () => {
    expect(shapeContent('channels.tools', 'webhook', 'build failed')).toBe('[webhook] build failed')
  })

  test('an empty body still names its origin', () => {
    expect(shapeContent('channels.tools', 'webhook', '')).toBe('[webhook] ')
  })

  test.each([
    ['a single rule', 'intro\n\n---\nrest'],
    ['consecutive rules', 'a\n\n---\n\n---\nb'],
    ['a rule at the very start', '\n\n---\nbody'],
    ['a rule followed by blank lines', 'a\n\n---\n\nb'],
  ])('%s survives channels.tools unsplit', (_label, content) => {
    const shaped = shapeContent('channels.tools', 'webhook', content)
    expect(shaped).not.toContain('\n\n---\n')
    expect(channelsToolsBody(shaped)).toBe(shaped)
  })

  test('a rule not preceded by a blank line is left alone (not the sentinel)', () => {
    expect(shapeContent('channels.tools', 'o', 'a\n---\nb')).toBe('[o] a\n---\nb')
  })

  test('"---" without a following newline is left alone (not the sentinel)', () => {
    expect(shapeContent('channels.tools', 'o', 'a\n\n---')).toBe('[o] a\n\n---')
  })
})
