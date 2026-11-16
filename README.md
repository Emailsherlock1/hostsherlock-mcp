# HostSherlock MCP (stdio)

`@hostsherlock/mcp` connects an MCP client that only starts local servers to the HostSherlock MCP server at `https://mcp.hostsherlock.com/v1/mcp`.

It is a relay. It passes each message to the remote server and returns the answer unchanged, so the tools, their descriptions and their results all come from HostSherlock. Setup guide and tool list: https://www.hostsherlock.com/mcp

## Do you need this package?

If your client accepts a server URL (claude.ai, ChatGPT, Claude Code, Cursor), add `https://mcp.hostsherlock.com/v1/mcp` directly and skip this package. claude.ai and ChatGPT sign you in through a browser window and need no API key.

Use this package when your client only takes a command to start, as in a `command` / `args` block in its config.

## Setup

1. Create an API key under Account → API keys: https://www.hostsherlock.com/admin/my/api/keys
2. Add the server to your client's config:

```json
{
  "mcpServers": {
    "hostsherlock": {
      "command": "npx",
      "args": ["-y", "@hostsherlock/mcp"],
      "env": { "HOSTSHERLOCK_API_KEY": "YOUR_API_KEY" }
    }
  }
}
```

Requires Node.js 18 or newer.

## Environment variables

| Variable | Purpose |
|---|---|
| `HOSTSHERLOCK_API_KEY` | Your API key. Sent as `Authorization: Bearer <key>` on every request. |
| `HOSTSHERLOCK_MCP_URL` | Overrides the endpoint. Defaults to `https://mcp.hostsherlock.com/v1/mcp`. The relay refuses any `http://` URL except `localhost`, so the key never travels unencrypted. |

## What the relay does not do

- **No browser sign-in.** The relay authenticates with the API key only. For the sign-in window, add the URL to a client that supports it.
- **No local logic.** It does not cache, rewrite or filter tool calls. Each call counts against your key's rate limit exactly as a direct connection would.
- **No output on stdout except protocol messages.** Diagnostics, such as a rejected key, go to stderr. The request that failed also gets a JSON-RPC error with the same sentence, so your client can show it.

## Development

```bash
npm install
npm test   # builds, then runs the relay against a local MCP server
```

## License

MIT
