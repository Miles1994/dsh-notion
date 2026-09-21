# dsh-notion-mcp

Connect [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (`dsh`) to [Notion](https://www.notion.com) through the official Notion MCP server, using OAuth 2.0 (authorization code + PKCE). After a one-time browser authorization, your `dsh` agent can search, read, and write Notion pages, databases, and comments through the standard `mcp__notion__*` tools.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node: 22.19%2B%20or%2024%2B](https://img.shields.io/badge/Node-22.19%2B%20or%2024%2B-339933.svg)](https://nodejs.org) [![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[中文](README.md) | English

## What it does for you

Once installed, your `dsh` agent can read and write Notion directly. You authorize once in your browser, then **just talk normally** — mention that you want to work with Notion and the plugin connects, reclaiming the mount with the session when you are done. It runs the full OAuth 2.0 (authorization code + PKCE) flow, stores the tokens securely in dsh's credential seam, keeps them refreshed for the life of the session, and mounts Notion's search, page, database, and comment tools under `mcp__notion__*`.

## How this differs from an always-on mount

The full Notion tools never appear out of nowhere, and never sit in context permanently:

- **A new conversation, or one that never mentions Notion**: context carries only a tiny `notion_connect` bootstrap tool (a few dozen tokens) instead of ~40 full schemas.
- **When you mention working with Notion**: the plugin mounts the full tools, scoped to that conversation's own agent scope.
- **The mount is reclaimed with the agent scope**: when the conversation ends (or the agent is disposed) the connection and its tools go away with it.

That keeps "say one sentence and it works" while removing the standing cost of "install once, pay the tool-definition tokens in every turn forever".

## Features

- **Keyword auto-connect** — a message that names Notion *and* carries an action intent (read / search / write / record / to-do / doc …) mounts automatically.
- **Model bootstrap** — when the keyword rule does not fire, the model can call the always-present `notion_connect` tool itself.
- **Explicit escape hatch** — the `/notion` command is always available to force a connection or dispatch a task.
- **Per-conversation isolation** — tools live in the agent's own scope and never leak into other conversations.
- **Zero-config OAuth** — dynamic client registration (RFC 7591) registers a client at runtime; no `client_id` or secret to copy.
- **One-time browser login** — `dsh notion login` prints an authorization URL and waits for the callback on `127.0.0.1:53007`.
- **Silent token refresh** — access tokens (~8 h) refresh automatically before expiry and the live connection is rebuilt with the new token; the rotated refresh token is persisted atomically.
- **Terminal `invalid_grant` handling** — an expired or rotated-away refresh token is never retried; the plugin clears it and asks you to re-authorize.
- **No secrets in the repo** — tokens live in dsh's credential store, not in this repository.

## Usage

**Just talk** — mentioning that you want to work with Notion connects automatically:

```text
What are my to-dos in notion today?
Analyze the current architecture and record it in notion
Sync these review notes to Notion
```

For precise control, use the explicit command:

```text
/notion Summarize the "Architecture Design" doc in Notion
/notion         # connect only, dispatch no task (keep chatting afterwards)
```

### Keyword rule

The trigger requires Notion **and** an action intent, so messages that merely *discuss* Notion do not fire:

```text
What is the difference between notion and Feishu?   ← no action intent
What are my to-dos today?                           ← does not name Notion
Don't use notion, write it locally                  ← explicit opt-out
```

If you want Notion but phrase it without an action word, the model can still call `notion_connect` itself.

### Why it works in the same turn

The crucial detail: **the tool list is finalized before the model request is built.** So the plugin cannot simply mount on a keyword match — the tools would only land on the next step, and the model would first answer "I cannot access Notion".

Two paths avoid that trap:

1. **Keyword hit** → mount inside the `agent/pre-step` hook, then re-queue the message and `reject` the step. A `reject` builds no model request (no tokens spent); the re-queued message is re-assembled on the next step with the new tools in place.
2. **Keyword miss** → the model calls `notion_connect`, which returns only after the tools are truly registered, so the model's **very next step** sees them.

Either way, the first time the model actually reaches for a Notion tool, the tool is guaranteed to be there.

## Configuration

| Key | Default | Description |
| --- | --- | --- |
| `mcpUrl` | `https://mcp.notion.com/mcp` | Notion MCP server URL |
| `port` | `53007` | Local OAuth callback port (`127.0.0.1`) |
| `autoTrigger` | `true` | Auto-mount on a keyword match; set `false` to keep only `/notion` and `notion_connect` |
| `connectTool` | `true` | Register the always-present `notion_connect` tool; set `false` for zero standing injection |


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
a conversation mentions working with Notion (or sends /notion)
   │  5. Load the token, refreshing it if near expiry
   │  6. Mount the MCP client under that agent's scope and await registration
   │  7. Re-assemble this step's request, now with the tools in place
   ▼
Notion tools available as mcp__notion__* for that conversation only
```

`dsh notion login` only authorizes and persists the token — it does **not** mount a connection. The connection happens when a conversation needs Notion (keyword auto-connect, model bootstrap, or the explicit `/notion` command), mounted under that agent's own scope (`agent.ctx`), which is exactly why the tools never leak into other conversations. Near expiry the token is refreshed silently inside the session, serialized so a rotated refresh token is never replayed concurrently.

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

Authorization does **not** mount anything immediately. Afterwards, mention that you want to work with Notion in a conversation (or send `/notion` directly) to make the tools available under `mcp__notion__*` for that conversation.

## Uninstall

```sh
dsh plugin --profile web remove dsh-notion-mcp
```

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
