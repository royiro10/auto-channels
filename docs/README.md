# Auto Channels documentation

Start with the [README](../README.md): requirements, the quickstart and the one hard rule.

- [Writing your own source](sources.md): the contract, gating, testing, disabling, opt-in
  delivery, and multiple sessions with the subscribe tools.
- [Builtin sources](builtins.md): `webhook`, `cron` and `filedrop`, their options and env
  fallbacks.
- [Configuration](configuration.md): every env var, and which errors fail the session vs.
  only one source.
- [Using it from pi](pi.md): the pi host through the channels.tools extension.
- [Architecture and debugging](architecture.md): the daemon, `daemon.log` and the status file,
  restarts, and known limitations.
- [How Claude Code channels behave](claude-code-channels.md): what the platform does and
  doesn't deliver, and the manual live-session check.
