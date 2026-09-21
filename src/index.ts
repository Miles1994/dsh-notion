import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
// 类型位置引入以激活 `dsh-commands` 对 cordis `Context` 的 `commands` 服务增强；
// 该增强是模块声明合并，仅引类型即可生效，运行时不产生额外依赖。
import '@deepseek-ai/dsh-commands'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { NotionTokenStore, type NotionTokens } from './notion-token-store.js'
import { messageText, shouldTriggerNotion, isTriggerableMessage } from './notion-trigger.js'
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
  /**
   * Mount automatically when a message names Notion with an action intent.
   * Disable to require the explicit `/notion` command or the `notion_connect` tool.
   */
  autoTrigger: z.boolean().default(true),
  /**
   * Keep the tiny `notion_connect` bootstrap tool registered. It lets the model
   * connect Notion itself when the keyword rule does not fire.
   */
  connectTool: z.boolean().default(true),
})

type Cfg = { mcpUrl: string; port: number; autoTrigger: boolean; connectTool: boolean }

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
  /**
   * Set while a pre-step auto-connect owns the mount, so a rejected and
   * re-queued message does not try to mount a second time on its way back.
   */
  autoConnecting?: boolean
}

/**
 * The always-registered bootstrap tool.
 *
 * A keyword match alone cannot make tools visible in the same step: the agent
 * loop assembles the tool list *before* it dispatches `agent/pre-step`, so a
 * mount performed inside that hook only lands in the NEXT step. This tiny tool
 * closes that gap deterministically — the model calls it, the call returns
 * after the real tools are registered, and the following step sees them.
 *
 * It costs a few dozen tokens instead of the ~40 full Notion schemas, which is
 * the entire point of connecting on demand.
 */
const CONNECT_TOOL = 'notion_connect'

/**
 * Mount state for one plugin instance, keyed by agent session id.
 *
 * Deliberately instance-scoped rather than module-level: a module-global map
 * would survive plugin reloads and leak stale mount state into a fresh
 * instance, silently suppressing the trigger for every agent it remembered.
 */
type MountRegistry = Map<string, AgentMount>

function mountFor(mounts: MountRegistry, agent: Agent): AgentMount {
  let mount = mounts.get(agent.id)
  if (!mount) {
    mount = { refreshMutex: { running: false } }
    mounts.set(agent.id, mount)
  }
  return mount
}

/** The existing mount for this agent, if any — never creates one. */
function existingMount(mounts: MountRegistry, agent: Agent): AgentMount | undefined {
  return mounts.get(agent.id)
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
  // 已挂载则直接复用：mcp-client 对同一作用域内重复的 serverName 会抛错，
  // 因此这里必须拦住第二次挂载（重复 /notion、已连接后调用 notion_connect 等）。
  // refreshAndRemount 会先 unmount（其内部清空 child）再调用本函数，故不受影响。
  if (mount.child) return
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
  const mounts: MountRegistry = new Map()

  // 不再在启动时自动挂载：没有 token 时不提示、有 token 时也不连接。
  // 工具只在一个会话真正执行 /notion 后，挂到该 agent 自己的作用域里生效。

  // 命令面：`/notion [任务]` 挂载本会话专用的 Notion 工具并投递任务。
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'notion',
      description: 'Mount Notion MCP tools for this conversation and run a task against them',
      input: { hint: '[task]' },
      handler: async ({ agent, rawInput }: CommandInvocation) => {
        const mount = mountFor(mounts, agent)
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

  // 常驻微型工具（方案 B）：模型只需调用它即可让完整 Notion 工具在下一步可用。
  // 这是关键字之外的自举路径，保证任何表述下都能连上，且不依赖网络先于请求。
  if (config.connectTool !== false) ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register(defineTool({
      name: CONNECT_TOOL,
      description:
        'Connect the Notion tools for this conversation. Call this FIRST when the user wants to '
        + 'read from or write to Notion (pages, databases, comments, to-dos); the full mcp__notion__* '
        + 'tools become available on your next step. Do not call it for questions merely about Notion.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { connected: { type: 'boolean', required: true } },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.connected
            ? 'Notion tools are connected. Call the mcp__notion__* tools now to continue the task.'
            : 'Notion could not be connected; report the failure to the user instead of retrying blindly.',
        }],
      },
      execute: async (_args, exec) => {
        const agent = exec.agent
        if (agent === undefined) throw new Error(`${CONNECT_TOOL} requires a calling agent`)
        const mount = mountFor(mounts, agent)
        const result = await connect(agent, store, config, mount)
        if (!result.ok) throw new Error(result.text)
        return { connected: true }
      },
    }))
  })

  // 关键字自动挂载（方案 A）。pre-step 是消息进入模型前的最后一道 waterfall，
  // 但工具清单在其之前就已 assemble，因此挂载必须靠「reject + 重排该消息」来生效：
  // reject 不产生模型请求，消息重新入队后下一步会带着新工具重新组装。
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
    // 缺省视为开启：直接调用 apply() 的宿主（含测试）不会经过 schema 默认值填充。
    if (config.autoTrigger === false) return next()
    const mount = existingMount(mounts, agent)
    if (mount?.child || mount?.autoConnecting) return next()

    const trigger = messages.find(
      (message: UserMessage) => isTriggerableMessage(message) && shouldTriggerNotion(messageText(message)),
    )
    if (trigger === undefined) return next()

    // 消费掉这轮触发，避免重排回来的同一条消息再次触发（形成 reject 死循环）。
    const active = mountFor(mounts, agent)
    active.autoConnecting = true
    try {
      const result = await connect(agent, store, config, active)
      if (!result.ok) {
        // 连不上时不要吞掉用户消息：放行本次 step，让模型按普通对话处理并如实说明。
        console.error(`[dsh-notion-mcp] auto-connect failed: ${result.text}`)
        return next()
      }
    } catch (e) {
      console.error(e)
      return next()
    } finally {
      active.autoConnecting = false
    }

    signal.throwIfAborted()
    // 把这批已被 claim 的消息按原顺序放回 next-step。reject 语义规定被 claim 的消息
    // 「既不落库也不再重发」，因此不重排就会整批丢失。逆序遍历配合 prepend 才能保序。
    for (const message of [...messages].reverse()) {
      if (agent.inbox.nextStep.some((c) => c.id === message.id)) continue
      if (agent.inbox.nextTurn.some((c) => c.id === message.id)) continue
      agent.inbox.prepend('next-step', message)
    }
    return { kind: 'reject' }
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

  // agent 销毁时释放挂载状态；工具本身随 agent 作用域自动回收，这里只清理映射，
  // 否则长进程里 mounts 会随会话数无限增长。
  ctx.on('agent/disposed', ({ agent }) => {
    const mount = mounts.get(agent.id)
    if (mount === undefined) return
    mounts.delete(agent.id)
    void unmount(mount)
  })

  // cordis 4.0.1 用 `ctx.effect(() => disposer)` 做清理，不是 `ctx.on('dispose')`。
  // 这里兜住插件自身卸载时仍存活的挂载；正常路径下随 agent 作用域一起回收。
  ctx.effect(() => () => {
    for (const mount of mounts.values()) void unmount(mount)
    mounts.clear()
  })
}
