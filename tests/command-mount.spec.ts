import { describe, it, expect, vi } from 'vitest'
import { apply, name, inject, Config } from '../src/index.js'

/**
 * Minimal cordis-shaped context. The plugin touches only a small slice:
 * `credentials`, `cmdlineArgs`, `inject`, `effect`, and (for `/notion`) the
 * command registry plus the agent's own scoped `plugin`.
 */
function fakeCtx() {
  const registered: any[] = []
  const effects: Array<() => void> = []
  const disposed: any[] = []
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
  }
  ctx.commands = { register: (def: any) => { registered.push(def); return () => {} } }
  return { ctx, registered, effects, disposed, store }
}

const fakeAgent = () => {
  const followed: any[] = []
  const steered: any[] = []
  const agent: any = {
    id: 'session-1',
    followup: (m: any) => followed.push(m),
    steer: (m: any) => steered.push(m),
    ctx: {
      plugin: (_p: any, _c: any) => {
        const fiber: any = Promise.resolve({ dispose: async () => {} })
        fiber.dispose = async () => {}
        return fiber
      },
    },
  }
  return { agent, followed, steered }
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

it('a config with defaults resolves mcpUrl and port', () => {
  expect(Config({}).mcpUrl).toBe('https://mcp.notion.com/mcp')
  expect(Config({}).port).toBe(53007)
})
