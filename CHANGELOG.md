# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Pre-1.0: minor
versions may break.

## [Unreleased]

## [0.1.0] - 2026-10-30

### Added

- The first release: hot-reloaded event sources push outside events into a live
  Claude Code or pi session through one shared daemon per project.
- The `webhook`, `cron` and `filedrop` builtins, `auto-channels init`, and the mock
  context for testing sources.
- `init` installs from GitHub: `bunx github:royiro10/auto-channels init` follows the
  latest, `--ref <tag|branch|commit>` pins it.

[Unreleased]: https://github.com/royiro10/auto-channels/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/royiro10/auto-channels/releases/tag/v0.1.0
