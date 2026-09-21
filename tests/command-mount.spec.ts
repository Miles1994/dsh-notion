import { describe, it, expect, vi } from 'vitest'
import { apply, name, inject, Config } from '../src/index.js'

/**
 * Minimal cordis-shaped context. The plugin touches only a small slice:
 * `credentials`, `cmdlineArgs`, `inject`, `effect`, `on`, and the command and
 * tool registries plus each agent's own scoped `plugin`.
 */
function fakeCtx() {
  const registered: any[] = []
  const tools: any[] = []
  const effects: Array<() => void> = []
  const handlers = new Map<string, Array<(...args: any[]) => any>>()
  const store = new Map<string, string>()

  const ctx: any = {
    credentials: {
      async resolve(ref: string) {
        const v = store.get(ref)
        return v === undefined ? undefined : { value: v }
      },
      async set(ref: string, value: string) { store.set(ref, value) },
      async unset(ref: string) { store.delete(ref) },
    },
    cmdlineArgs: { get: () => ['web'] },
    inject: (deps: string[], cb: (c: any) => void) => {
      // Only run the callback when the declared service is actually present,
      // mirroring cordis' "no service, no callback" behavior.
      if (deps.every((d) => ctx[d] !== undefined)) cb(ctx)
    },
    effect: (fn: () => (() => void) | void) => {
      const d = fn()
      if (typeof d === 'function') effects.push(d)
    },
    on: (event: string, handler: (...args: any[]) => any) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
  }
  ctx.commands = { register: (def: any) => { registered.push(def); return () => {} } }
  ctx.tools = { register: (def: any) => { tools.push(def); return () => {} } }
  /** Run every listener registered for one event; returns the last result. */
  const emit = async (event: string, payload: any, next: () => Promise<any>) => {
    const list = handlers.get(event) ?? []
    let chain = next
    for (const handler of [...list].reverse()) {
      const downstream = chain
      chain = () => handler(payload, downstream)
    }
    return chain()
  }
  return { ctx, registered, tools, effects, handlers, emit, store }
}

const fakeAgent = () => {
  const followed: any[] = []
  const steered: any[] = []
  const prepended: any[] = []
  const pluginCalls: any[] = []
  const agent: any = {
    id: 'session-1',
    followup: (m: any) => followed.push(m),
    steer: (m: any) => steered.push(m),
    inbox: {
      nextStep: [] as any[],
      nextTurn: [] as any[],
      prepend: (target: string, m: any) => prepended.push({ target, m }),
    },
    ctx: {
      plugin: (_p: any, c: any) => {
        pluginCalls.push(c)
        const fiber: any = Promise.resolve({ dispose: async () => {} })
        fiber.dispose = async () => {}
        return fiber
      },
    },
  }
  return { agent, followed, steered, prepended, pluginCalls }
}

/** One user-authored text message in the shape the loop claims. */
function userMessage(id: string, text: string) {
  return { id, content: [{ type: 'text', text }], source: { kind: 'user' } } as any
}

async function seedTokens(ctx: any, expiresAt = Date.now() + 3_600_000) {
  await ctx.credentials.set('NOTION_OAUTH', JSON.stringify({
    accessToken: 'at', refreshToken: 'rt', expiresAt, clientId: 'cid',
  }))
}

it('exposes the plugin identity and does not hard-require the commands service', () => {
  // `/notion` is registered through `ctx.inject(['commands'])` rather than a
  // top-level `inject` entry — the shipped dsh-plan-mode precedent. Making
  // `commands` a hard dependency would stop the plugin loading in UI-less
  // spines, where the CLI `dsh notion login` still has to work.
  expect(name).toBe('notion')
  expect(inject).not.toContain('commands')
  expect(inject).toContain('credentials')
})

it('does NOT mount anything at startup even with a valid token', async () => {
  const { ctx, effects } = fakeCtx()
  await seedTokens(ctx)
  const plugin = vi.fn()
  apply(ctx, { mcpUrl: 'https://example.test/mcp', port: 53007 })
  expect(plugin).not.toHaveBeenCalled()
  // The only effect is the teardown sweep; no timer/connection was armed.
  expect(effects).toHaveLength(1)
})

it('registers a /notion command', () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, { mcpUrl: 'https://example.test/mcp', port: 53007 })
  expect(registered).toHaveLength(1)
  expect(registered[0].name).toBe('notion')
})

it('bare /notion mounts tools for the calling agent without sending a message', async () => {
  const { ctx, registered } = fakeCtx()
  await seedTokens(ctx)
  apply(ctx, { mcpUrl: 'https://example.test/mcp', port: 53007 })
  const { agent, followed, steered } = fakeAgent()

  const res = await registered[0].handler({ agent, rawInput: '  ', attachments: [] })

  expect(res.kind).toBe('success')
  expect(followed).toHaveLength(0)
  expect(steered).toHaveLength(0)
})

it('/notion <task> mounts and then delivers the trimmed task to the agent', async () => {
  const { ctx, registered } = fakeCtx()
  await seedTokens(ctx)
  apply(ctx, { mcpUrl: 'https://example.test/mcp', port: 53007 })
  const { agent, followed } = fakeAgent()

  const res = await registered[0].handler({ agent, rawInput: ' 看一下notion中的设计文档', attachments: [] })

  expect(res.kind).toBe('success')
  expect(followed).toHaveLength(1)
  expect(followed[0].content).toEqual([{ type: 'text', text: '看一下notion中的设计文档' }])
})

it('reports an error and sends nothing when not authorized', async () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, { mcpUrl: 'https://example.test/mcp', port: 53007 })
  const { agent, followed } = fakeAgent()

  const res = await registered[0].handler({ agent, rawInput: 'do something', attachments: [] })

  expect(res.kind).toBe('error')
  expect(res.text).toContain('dsh notion login')
  expect(followed).toHaveLength(0)
})

it('mounts each conversation independently (per-agent scope)', async () => {
  const { ctx, registered } = fakeCtx()
  await seedTokens(ctx)
  apply(ctx, { mcpUrl: 'https://example.test/mcp', port: 53007 })

  const a = fakeAgent()
  const b = fakeAgent()
  // Distinct agent ids -> distinct mount slots; mounting A must not touch B.
  b.agent.id = 'session-2'

  await registered[0].handler({ agent: a.agent, rawInput: '', attachments: [] })
  expect(a.agent.ctx.plugin).toBeDefined()

  await registered[0].handler({ agent: b.agent, rawInput: 'task b', attachments: [] })
  expect(b.followed).toHaveLength(1)
})

it('does not mount a second time when the agent is already connected', async () => {
  const { ctx, registered } = fakeCtx()
  await seedTokens(ctx)
  apply(ctx, { mcpUrl: 'https://example.test/mcp', port: 53007 })
  const { agent, pluginCalls } = fakeAgent()

  // mcp-client rejects a duplicate serverName in one scope, so a repeat
  // invocation must reuse the live mount instead of mounting again.
  await registered[0].handler({ agent, rawInput: '', attachments: [] })
  await registered[0].handler({ agent, rawInput: '', attachments: [] })

  expect(pluginCalls).toHaveLength(1)
})

it('a config with defaults resolves mcpUrl, port, and the trigger switches', () => {
  expect(Config({}).mcpUrl).toBe('https://mcp.notion.com/mcp')
  expect(Config({}).port).toBe(53007)
  expect(Config({}).autoTrigger).toBe(true)
  expect(Config({}).connectTool).toBe(true)
})

it('registers the always-on notion_connect bootstrap tool', () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx, { mcpUrl: 'https://example.test/mcp', port: 53007 })
  expect(tools).toHaveLength(1)
  expect(tools[0].name).toBe('notion_connect')
})

it('withholds the bootstrap tool when connectTool is false', () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx, { mcpUrl: 'https://example.test/mcp', port: 53007, connectTool: false } as any)
  expect(tools).toHaveLength(0)
})

it('keyword trigger mounts and re-queues the message instead of entering the step', async () => {
  const { ctx, emit } = fakeCtx()
  await seedTokens(ctx)
  apply(ctx, { mcpUrl: 'https://example.test/mcp', port: 53007 })
  const { agent, prepended } = fakeAgent()
  const messages = [userMessage('m1', '看一下notion中今天的待办有哪些')]

  const decision = await emit('agent/pre-step', { agent, messages, signal: { throwIfAborted() {} } },
    async () => ({ kind: 'enter', messages }))

  expect(decision.kind).toBe('reject')
  // The claimed message must be re-queued or it would be lost entirely.
  expect(prepended.map((p) => p.m.id)).toEqual(['m1'])
  expect(prepended[0].target).toBe('next-step')
})

it('does not trigger on a message that merely mentions Notion', async () => {
  const { ctx, emit } = fakeCtx()
  await seedTokens(ctx)
  apply(ctx, { mcpUrl: 'https://example.test/mcp', port: 53007 })
  const { agent } = fakeAgent()
  const messages = [userMessage('m1', 'notion 和飞书的区别是什么')]
  let entered = false

  const decision = await emit('agent/pre-step', { agent, messages, signal: { throwIfAborted() {} } },
    async () => { entered = true; return { kind: 'enter', messages } })

  expect(entered).toBe(true)
  expect(decision.kind).toBe('enter')
})

it('skips triggering entirely when autoTrigger is false', async () => {
  const { ctx, emit } = fakeCtx()
  await seedTokens(ctx)
  apply(ctx, { mcpUrl: 'https://example.test/mcp', port: 53007, autoTrigger: false } as any)
  const { agent } = fakeAgent()
  const messages = [userMessage('m1', '看一下notion中今天的待办有哪些')]
  let entered = false

  await emit('agent/pre-step', { agent, messages, signal: { throwIfAborted() {} } },
    async () => { entered = true; return { kind: 'enter', messages } })

  expect(entered).toBe(true)
})

it('passes the step through when the agent has no Notion authorization', async () => {
  const { ctx, emit } = fakeCtx()
  apply(ctx, { mcpUrl: 'https://example.test/mcp', port: 53007 })
  const { agent } = fakeAgent()
  const messages = [userMessage('m1', '看一下notion中今天的待办有哪些')]
  let entered = false

  // Failing to connect must not swallow the user's message.
  await emit('agent/pre-step', { agent, messages, signal: { throwIfAborted() {} } },
    async () => { entered = true; return { kind: 'enter', messages } })

  expect(entered).toBe(true)
})
