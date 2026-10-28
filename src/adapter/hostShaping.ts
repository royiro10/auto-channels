/*
 * Claude Code renders every notification as its own <channel> tag with meta intact,
 * so it gets content verbatim. channels.tools (pi) loses information
 * two ways: events queued mid-turn are coalesced per SERVER, dropping `origin`, and
 * content is split at "\n\n---\n", the tail read as server guidance.
 */

/*
 * channels.tools splits content at the first "\n\n---\n". Backslash-escaping
 * the rule keeps it literal (and still reads as a rule-that-isn't in
 * markdown); the lookahead leaves the trailing newline unconsumed so a run of
 * consecutive rules ("\n\n---\n\n---\n") is fully escaped in one pass.
 */
const GUIDANCE_SENTINEL = /\n\n---(?=\n)/g

/**
 * Shape `content` for the MCP client named `clientName` (its `clientInfo.name`). channels.tools gets
 * `[origin] ` as a prefix, so each event's first line — which channels.tools also uses as the visible
 * summary — still names its source after coalescing, and the guidance sentinel escaped. Anything else,
 * including a client not initialized yet, is treated as Claude Code: verbatim is the safe default.
 */
export function shapeContent(clientName: string | undefined, origin: string, content: string): string {
  if (clientName !== 'channels.tools') return content
  return `[${origin}] ${content.replace(GUIDANCE_SENTINEL, '\n\n\\---')}`
}
