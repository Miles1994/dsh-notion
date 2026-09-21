import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
// 类型位置引入以激活 `dsh-commands` 对 cordis `Context` 的 `commands` 服务增强；
// 该增强是模块声明合并，仅引类型即可生效，运行时不产生额外依赖。
import '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { NotionTokenStore, type NotionTokens } from './notion-token-store.js'
import {
  discoverOAuth,
  registerClient,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  generateVerifier,
  generateState,
  computeChallenge,
  InvalidGrantError,
} from './notion-oauth.js'
import { startLoginServer } from './login-server.js'

export const name = 'notion'
export const inject = ['cmdlineArgs', 'credentials']

export const Config = z.object({
  mcpUrl: z.string().default('https://mcp.notion.com/mcp'),
  port: z.number().default(53007),
})

type Cfg = { mcpUrl: string; port: number }

/**
 * One lazily-mounted, agent-scoped MCP connection.
 *
 * Mounting beneath `agent.ctx` is what makes `/notion` conversation-local: the
 * tools land in the agent's own scoped layer, so a session that never runs the
 * command sees no `mcp__notion__*` tool at all, and the tools unwind with the
 * agent scope instead of leaking into every later conversation.
 */
interface AgentMount {
  child?: Fiber
  /** In-flight mount, so concurrent `/notion` invocations share one connection. */
  pending?: PromiseLike<Fiber>
  refreshTimer?: ReturnType<typeof setTimeout>
  refreshMutex: { running: boolean }
}

/** Live mounts keyed by agent session id. Entries are removed on agent disposal. */
const mounts = new Map<string, AgentMount>()

function mountFor(agent: Agent): AgentMount {
  let mount = mounts.get(agent.id)
  if (!mount) {
    mount = { refreshMutex: { running: false } }
    mounts.set(agent.id, mount)
  }
  return mount
}

async function unmount(mount: AgentMount): Promise<void> {
  if (mount.refreshTimer) {
    clearTimeout(mount.refreshTimer)
    mount.refreshTimer = undefined
  }
  const child = mount.child ?? (await Promise.resolve(mount.pending).catch(() => undefined))
  mount.pending = undefined
  mount.child = undefined
  if (child) await child.dispose()
}

/**
 * Mount the Notion MCP client beneath the agent's own scope and return only
 * once its initial tool generation is registered.
 *
 * `ctx.plugin()` returns a `Fiber & PromiseLike<Fiber>` and the mcp-client's
 * `apply` awaits `connection.ready`; awaiting the fiber is therefore the exact
 * point at which `mcp__notion__*` has reached `ctx.tools`. Steering the task
 * before this settles would race the request against tool registration and lose.
 */
async function mountMcp(agentCtx: Context, accessToken: string, config: Cfg, mount: AgentMount): Promise<void> {
  if (mount.pending) {
    await mount.pending
    return
  }
  const pending = agentCtx.plugin(mcpClient, {
    transport: 'streamable-http',
    serverName: 'notion',
    url: config.mcpUrl,
    headers: { Authorization: `Bearer ${accessToken}` },
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
  })
  mount.pending = pending
  try {
    mount.child = await pending
  } finally {
    mount.pending = undefined
  }
}

/**
 * Ensure a valid access token, refreshing (and persisting the rotated refresh
 * token) when the stored one is at or near expiry.
 */
async function ensureAccessToken(store: NotionTokenStore, config: Cfg, mount: AgentMount): Promise<string | undefined> {
  const tokens = await store.load()
  if (!tokens) return undefined
  if (tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken

  mount.refreshMutex.running = true
  try {
    const disc = await discoverOAuth(config.mcpUrl)
    const next = await refreshAccessToken(disc.tokenEndpoint, {
      clientId: tokens.clientId,
      refreshToken: tokens.refreshToken,
    })
    const refreshed: NotionTokens = {
      accessToken: next.accessToken,
      // Notion rotates refresh tokens; persisting the old one alongside the new
      // access token would strand the next refresh on a dead grant.
      refreshToken: next.refreshToken ?? tokens.refreshToken,
      expiresAt: Date.now() + next.expiresIn * 1000,
      clientId: tokens.clientId,
    }
    await store.save(refreshed)
    return refreshed.accessToken
  } catch (e) {
    if (e instanceof InvalidGrantError) {
      await store.clear()
      await unmount(mount)
      return undefined
    }
    throw e
  } finally {
    mount.refreshMutex.running = false
  }
}

/**
 * Proactively refresh the token before it expires and rebuild the live
 * connection with it.
 *
 * Re-mounting is not optional: the access token is baked into the mcp-client's
 * `Authorization` header at mount time, so a refreshed token that is only
 * persisted would leave the running connection authenticating with a stale
 * (and eventually rejected) header.
 */
async function refreshAndRemount(
  agentCtx: Context,
  store: NotionTokenStore,
  config: Cfg,
  mount: AgentMount,
): Promise<void> {
  if (mount.refreshMutex.running) return
  const token = await ensureAccessToken(store, config, mount)
  if (!token) return
  if (mount.child) await unmount(mount)
  await mountMcp(agentCtx, token, config, mount)
}

/** Arm a proactive refresh so a long-running session never hits an expired token mid-turn. */
function scheduleRefresh(
  agentCtx: Context,
  store: NotionTokenStore,
  config: Cfg,
  mount: AgentMount,
  expiresAt: number,
): void {
  if (mount.refreshTimer) clearTimeout(mount.refreshTimer)
  const delay = Math.max(60_000, expiresAt - Date.now() - 5 * 60_000)
  mount.refreshTimer = setTimeout(() => {
    mount.refreshTimer = undefined
    void refreshAndRemount(agentCtx, store, config, mount)
      .then(() => store.load())
      .then((t) => {
        if (t && mount.child) scheduleRefresh(agentCtx, store, config, mount, t.expiresAt)
      })
      .catch((e) => {
        // Transient failure (network / discovery): retry soon rather than
        // silently letting the mount die on an expired token.
        console.error(e)
        if (mount.child) scheduleRefresh(agentCtx, store, config, mount, Date.now() + 60_000)
      })
  }, delay)
}

/**
 * Connect for one agent: reuse a live mount, otherwise refresh the token and
 * mount under the agent scope. Returns the failure text to surface, if any.
 */
async function connect(
  agent: Agent,
  store: NotionTokenStore,
  config: Cfg,
  mount: AgentMount,
): Promise<{ ok: true } | { ok: false; text: string }> {
  const tokens = await store.load()
  if (!tokens) {
    return { ok: false, text: 'Notion 未授权。请先在终端运行 `dsh notion login` 完成授权。' }
  }
  let accessToken: string | undefined
  try {
    accessToken = await ensureAccessToken(store, config, mount)
  } catch (e) {
    return { ok: false, text: `Notion 令牌刷新失败：${(e as Error).message}` }
  }
  if (!accessToken) {
    return { ok: false, text: 'Notion 授权已失效。请重新运行 `dsh notion login`。' }
  }
  await mountMcp(agent.ctx, accessToken, config, mount)
  const fresh = await store.load()
  if (fresh) scheduleRefresh(agent.ctx, store, config, mount, fresh.expiresAt)
  return { ok: true }
}

async function runLogin(ctx: Context, store: NotionTokenStore, config: Cfg): Promise<void> {
  const redirectBase = `http://127.0.0.1:${config.port}/callback`
  const disc = await discoverOAuth(config.mcpUrl)
  const { clientId } = await registerClient(disc.registrationEndpoint, [redirectBase])
  const verifier = generateVerifier()
  const state = generateState()
  const authorizeUrl = buildAuthorizeUrl(disc.authorizationEndpoint, {
    clientId,
    redirectUri: redirectBase,
    state,
    codeChallenge: computeChallenge(verifier),
  })
  // 直接写终端：`dsh notion login` 这个 CLI 子命令下 ctx.logger 只进内存缓冲区，不落终端。
  console.log(`[dsh-notion-mcp] open this URL to authorize Notion:\n${authorizeUrl}`)
  const { wait } = await startLoginServer(state, config.port)
  const cb = await wait
  const tokens = await exchangeCode(disc.tokenEndpoint, {
    clientId, code: cb.code, redirectUri: redirectBase, codeVerifier: verifier,
  })
  if (!tokens.refreshToken) {
    throw new Error('authorization response missing refresh_token — cannot persist a usable token')
  }
  const stored: NotionTokens = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
    clientId,
  }
  await store.save(stored)
  // 登录进程随后调用 appExit 退出，且不再常驻挂载：这里只负责把凭证落盘。
  console.log('[dsh-notion-mcp] authorized — run /notion in a conversation to mount the tools')
}

export function apply(ctx: Context, config: Cfg): void {
  const store = new NotionTokenStore(ctx.credentials)
  const isNotionCommand = (ctx.cmdlineArgs?.get() ?? [])[0] === 'notion'

  // 不再在启动时自动挂载：没有 token 时不提示、有 token 时也不连接。
  // 工具只在一个会话真正执行 /notion 后，挂到该 agent 自己的作用域里生效。

  // 命令面：`/notion [任务]` 挂载本会话专用的 Notion 工具并投递任务。
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'notion',
      description: 'Mount Notion MCP tools for this conversation and run a task against them',
      input: { hint: '[task]' },
      handler: async ({ agent, rawInput }: CommandInvocation) => {
        const mount = mountFor(agent)
        const task = rawInput.trim()

        const result = await connect(agent, store, config, mount)
        if (!result.ok) return { kind: 'error', text: result.text }

        if (task !== '') {
          // 挂载已完成（工具已进 ctx.tools），此时投递任务可保证模型本轮就能用上 Notion 工具。
          // 用 followup 而非 steer：空闲驱动下开启独立的一轮，语义更贴近「执行这个任务」。
          agent.followup(createUserMessage({
            content: [{ type: 'text', text: task }],
            source: { kind: 'user' },
          }))
          return { kind: 'success', text: 'Notion 已连接，正在处理该任务…' }
        }

        return { kind: 'success', text: 'Notion 已连接，本会话可使用 Notion 工具。' }
      },
    })
  })

  // 登录命令：只有当本次调用就是 `dsh ... notion ...` 时才接管命令行解析；否则（如
  // `dsh web`）命令行归 app（web/headless）所有。
  if (isNotionCommand) {
    const program = new Command()
    program
      .command('notion')
      .command('login')
      .description('Authorize Notion via the official MCP OAuth flow')
      .action(() => {
        void runLogin(ctx, store, config)
          .then(() => ctx.appExit?.(0))
          .catch((e) => { console.error(e); ctx.appExit?.(1) })
      })
    parseCmdline(ctx, program)
  }

  // cordis 4.0.1 用 `ctx.effect(() => disposer)` 做清理，不是 `ctx.on('dispose')`。
  // 这里兜住插件自身卸载时仍存活的挂载；正常路径下随 agent 作用域一起回收。
  ctx.effect(() => () => {
    for (const mount of mounts.values()) void unmount(mount)
    mounts.clear()
  })
}
