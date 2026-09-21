# dsh-notion-mcp

Connect [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (`dsh`) to [Notion](https://www.notion.com) through the official Notion MCP server, using OAuth 2.0 (authorization code + PKCE). After a one-time browser authorization, your `dsh` agent can search, read, and write Notion pages, databases, and comments through the standard `mcp__notion__*` tools.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node: 22.19%2B%20or%2024%2B](https://img.shields.io/badge/Node-22.19%2B%20or%2024%2B-339933.svg)](https://nodejs.org) [![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[中文](README.md) | English

## What it does for you

Once installed, your `dsh` agent can read and write Notion directly. You authorize once in your browser, then **connect on demand with `/notion` in the conversations that need it**: the plugin runs the full OAuth 2.0 (authorization code + PKCE) flow, stores the tokens securely in dsh's credential seam, keeps them refreshed for the life of the session, and mounts Notion's search, page, database, and comment tools under `mcp__notion__*`.

## How this differs from an always-on mount

The tools do **not** appear in every conversation. Only a conversation that has run `/notion` mounts them, and the mount is scoped to that conversation's own agent scope:

- A new conversation — or any conversation that never ran `/notion` — sees **no** `mcp__notion__*` tools at all, so their descriptions never consume context there.
- The mount is reclaimed with the agent scope: when the conversation ends (or the agent is disposed) the connection and its tools go away with it.
- Connecting on demand removes the standing cost of "install once, pay the tool-definition tokens in every turn forever".

## Features

- **On-demand mounting** — only conversations that ran `/notion` connect to Notion; every other conversation has zero tool injection.
- **Per-conversation isolation** — tools live in the agent's own scope and never leak into other conversations.
- **Zero-config OAuth** — dynamic client registration (RFC 7591) registers a client at runtime; no `client_id` or secret to copy.
- **One-time browser login** — `dsh notion login` prints an authorization URL and waits for the callback on `127.0.0.1:53007`.
- **Silent token refresh** — access tokens (~8 h) refresh automatically before expiry and the live connection is rebuilt with the new token; the rotated refresh token is persisted atomically.
- **Terminal `invalid_grant` handling** — an expired or rotated-away refresh token is never retried; the plugin clears it and asks you to re-authorize.
- **No secrets in the repo** — tokens live in dsh's credential store, not in this repository.

## Usage

In any conversation:

```text
/notion Summarize the "Architecture Design" doc in Notion
```

The plugin first mounts the Notion tools for the current conversation, **waits until they are actually registered**, and only then hands the task to the model — so the model can use `mcp__notion__*` in that very turn.

```text
/notion         # connect only, dispatch no task (keep chatting afterwards)
```

The first task waits for the MCP connection and tool registration to settle, avoiding the race where the request is sent before the tools exist.


## Screenshots

Ask the `dsh` agent to summarize a technical architecture and write it into Notion:

![dsh request to write into Notion](./docs/screenshots/dsh-notion-sc1.png)

The resulting Notion page:

![Resulting Notion page](./docs/screenshots/dsh-notion-sc2.png)

## How it works

```text
dsh notion login
   │  1. OAuth discovery (RFC 9470 / RFC 8414)
   │  2. Dynamic client registration (RFC 7591)
   │  3. PKCE S256 + state → authorization URL
   ▼
browser approves → callback on 127.0.0.1:53007
   │  4. Exchange code (plus PKCE verifier) for tokens
   ▼
tokens persisted (no automatic mount from here on)
   ⋯
/notion <task> in some conversation
   │  5. Load the token, refreshing it if near expiry
   │  6. Mount the MCP client under that agent's scope and await registration
   │  7. Deliver the task as a fresh turn for the model
   ▼
Notion tools available as mcp__notion__* for that conversation only
```

`dsh notion login` only authorizes and persists the token — it does **not** mount a connection. The connection happens when a conversation runs `/notion`, mounted under that agent's own scope (`agent.ctx`), which is exactly why the tools never leak into other conversations. Near expiry the token is refreshed silently inside the session, serialized so a rotated refresh token is never replayed concurrently.

## Install

```sh
dsh plugin --profile web add dsh-notion-mcp
```

Replace `web` with whichever profile you run the agent in (`web`, `headless`, `tui`, …).

## Authorize

The `notion` command runs in a minimal profile — a UI app such as `web` owns its own command line and does not forward `notion` to the plugin. Tokens are stored globally, so authorize once from a minimal profile and every profile that has the plugin installed picks it up:

```sh
dsh plugin --profile notion add dsh-notion-mcp
dsh --profile notion notion login
```

The command registers a dynamic OAuth client, starts a temporary local HTTP server on `127.0.0.1:53007`, and prints an authorization URL. Open it in your browser and approve the request; Notion redirects to `http://127.0.0.1:53007/callback`, and the plugin validates the `state`, exchanges the code (plus the PKCE verifier) for tokens, and stores them.

Authorization does **not** mount anything immediately. Run `/notion` (or `/notion <task>`) in a conversation to make the Notion tools available under `mcp__notion__*` for that conversation.

## Uninstall

```sh
dsh plugin --profile web remove dsh-notion-mcp
```

## Configuration

| Key | Default | Description |
| --- | --- | --- |
| `mcpUrl` | `https://mcp.notion.com/mcp` | Notion MCP server URL |
| `port` | `53007` | Local OAuth callback port (`127.0.0.1`) |

## Security

- Tokens are stored through dsh's credential seam (`ctx.credentials`) as a single atomic entry and are never committed to this repository. No `client_id` or secret is embedded — the client is registered at runtime via dynamic client registration.
- Notion rotates the refresh token on every refresh; the new token is persisted atomically together with the access token.
- If Notion returns `invalid_grant` (refresh token expired or rotated away), the plugin clears the stored tokens and stops retrying — re-authorize with `dsh notion login`.

## Requirements

- [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (`dsh`) — verified compatible with `v0.1.0-rc.8`, `v0.1.1-rc.1`, `v0.1.1-rc.2`, and `v0.1.2-alpha.1`
- Node.js `^22.19.0` or `>=24.0.0` (matching dsh `v0.1.2-alpha.1`; Node 23 is outside the supported range)

## Development

```sh
npm install
npm run build      # tsdown → lib/
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

## License

[MIT](LICENSE) © 2026 mingzeng
