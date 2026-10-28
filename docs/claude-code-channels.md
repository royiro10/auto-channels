# How Claude Code channels behave

What this project relies on about the platform, from the
[channels docs](https://code.claude.com/docs/en/channels) and from testing against
real `claude` processes. Channels are a research preview: Claude Code v2.1.80+,
claude.ai or Console auth (not Bedrock/Vertex/Foundry), and explicit enablement for
Team/Enterprise orgs.

## What a channel is

An ordinary stdio MCP server that also declares
`capabilities.experimental['claude/channel']: {}`. Claude Code spawns it like any
MCP server and additionally listens for its push notifications. A channel may also
declare tools — that is what lets the adapter offer `autochannels_list_sources`,
`autochannels_subscribe` and `autochannels_unsubscribe`.

## How events render

The server pushes `notifications/claude/channel` with `{ content, meta }`:

- `content` becomes the body of a `<channel source="..." ...>` tag in the transcript.
- `meta` keys become tag attributes. Claude Code **silently drops non-identifier
  keys**, so this project rejects them loudly at the source instead.
- The `source` attribute is set by the platform from the MCP server's name, never
  from `meta` — which is why a source's name travels as `meta.origin`, and why
  `origin` and `source` are reserved meta keys.

## Delivery is fire-and-forget

A notification resolves when it hits the transport, not when Claude has read it.
With nobody listening — no session open, the server not loaded as a channel, an org
policy blocking it — the event is dropped with no error. No daemon can make events
durable past "nobody is connected", so this project queues nothing.

## Opting in, per session

- The set of attached MCP servers is read once, at session start. A new channel
  always needs a new session — which is why the adapter stays thin and sources
  hot-reload in the daemon instead.
- Being in `.mcp.json` is not enough: the server must also be named on
  `claude --channels ...` (or be org-approved). During the preview, custom channels
  need `claude --dangerously-load-development-channels server:<name>`.
- That flag does not bypass MCP approval: a project `.mcp.json` entry stays
  "Pending approval" until approved interactively.

## `-p` / print mode never receives events

Tested repeatedly with real `claude -p` sessions, one-shot and long-lived
`stream-json`: the channel attaches, the daemon broadcasts while the adapter is
connected, and the content **never** reaches the model. Print mode reads one input,
produces one turn and repeats; nothing can splice content in between. This is
architectural, not a timing race — so a real model reacting to an event stays a
manual check.

## Manual live-session check

No automated test drives a real interactive session. In a scratch consumer:

```bash
mkdir /tmp/channels-manual && cd /tmp/channels-manual
bun <path-to-this-repo>/src/cli.ts init --claude
printf "import { webhook } from 'auto-channels/builtins'\nexport default webhook({ allowedSenders: ['dev'] })\n" \
  > .channels/sources/webhook.ts
claude --dangerously-load-development-channels server:auto-channels
# approve "auto-channels" at the MCP prompt, then from another terminal:
curl -X POST -H "X-Sender: dev" localhost:8788 -d "hello from a real webhook"
```

The session should show `<channel source="auto-channels" origin="webhook" …>` and
react without a new prompt. Under pi, channels.tools installs its notification
handler only after `tools/list`, so an event in that first window can be missed.
