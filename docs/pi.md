# Using it from pi

The same adapter runs unmodified under the [pi](https://pi.dev) agent through the
[channels.tools](https://github.com/schuettc/pi-extensions/tree/main/packages/channels.tools)
extension (`pi install npm:channels.tools`, once per machine), which wakes an idle session
on an event and queues events that arrive mid-turn. `auto-channels init --pi` registers the
adapter in `.pi/channels.json` (`--claude --pi` for both hosts; plain `init` means `--claude`):

```json
{ "channelServers": { "auto-channels": {
    "command": "bun",
    "args": [".channels/node_modules/auto-channels/src/adapter/index.ts"],
    "env": { "AUTO_CHANNELS_ROOT": "./.channels" }
} } }
```

Then start a session with `pi`.

Because channels.tools merges queued events per server, each event's content arrives
prefixed with `[<source name>] ` under pi.
