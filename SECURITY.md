# Security policy

## Supported versions

Only the latest 0.x release gets fixes.

## Reporting a vulnerability

Report it through GitHub's private vulnerability reporting (the repository's
**Security** tab → **Report a vulnerability**), not in a public issue.

## The trust boundary

An event's `content` lands in an agent session that can run tools, so an ungated
source another process can reach is a **prompt-injection vector**. That includes a
localhost listener: any local process, or a browser tab, can POST to it. So:

- **Request-shaped sources gate on sender identity before emitting, localhost
  included.** The gate lives in each source. The `webhook` builtin *requires*
  `allowedSenders` and checks the `X-Sender` header against it; a custom source builds
  whatever gate fits (a token, an HMAC).
- The `webhook` builtin binds `127.0.0.1` only, and a throwing handler returns a
  generic 500 — never Bun's development error page with local paths and source.
- Attribution can't be spoofed: `origin` and `source` are reserved meta keys, and the
  adapter assigns `origin` last.
- `filedrop` never follows symlinks: it opens with `O_NOFOLLOW` and reads only that
  descriptor, so a symlink dropped or swapped into the watched directory can't leak
  another file.
- Sources and the daemon log to stderr and `daemon.log`; the adapter's stdout carries
  only MCP traffic.

Deliberately trusted: the consumer's own code and filesystem. Timers and file
watchers need no gate, and the adapter↔daemon Unix socket has no authentication
(same user). A way around a source's sender gate is a vulnerability.
