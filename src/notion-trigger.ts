/**
 * Decide whether a user message should auto-connect the Notion MCP tools.
 *
 * The rule is deliberately strict: the message must both name Notion and carry
 * an action intent. Naming Notion alone is usually a discussion ("Notion 和飞书
 * 的区别"), and an action alone is usually about something else ("看一下今天的
 * 待办" in a local TODO file), so neither half triggers on its own.
 *
 * @module
 */

/** Names for Notion. Latin forms are matched case-insensitively. */
const NOTION_ALIASES = ['notion']

/** Verbs and nouns that express "do something with a Notion object". */
const INTENT_WORDS = [
  // 读取类
  '看一下', '看看', '查一下', '查查', '查询', '查看', '检索', '搜索', '搜一下',
  '读取', '读一下', '打开', '列出', '列一下', '找一下', '找找', '总结', '汇总',
  '整理', '分析', '提取', '获取',
  // 写入类
  '记录', '写入', '写到', '记到', '存到', '保存', '同步', '更新', '创建', '新建',
  '添加', '追加', '发布', '归档', '录入',
  // 对象类：提到这些 Notion 概念基本可以确定是在操作 Notion
  '待办', '文档', '页面', '数据库', '笔记', '评论', '任务',
]

/**
 * Phrases that disable the trigger even when both halves appear, because the
 * message is talking *about* Notion rather than asking to use it.
 */
const NEGATIVE_PATTERNS = [
  /不要\s*(?:用|使用|打开|连接|访问)?\s*notion/i,
  /(?:别|无需|无需用|不必|不用)\s*(?:用|使用|打开|连接|访问)?\s*notion/i,
  /notion\s*(?:是什么|是啥|怎么用|如何用|的区别|有什么不同)/i,
  /(?:什么是|啥是)\s*notion/i,
]

/** Extract the plain text of a message's content blocks. */
export function messageText(message: { content?: unknown }): string {
  const content = message.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text: string } =>
      typeof block === 'object' && block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Whether this text should auto-connect Notion.
 *
 * @param text - the user message's plain text.
 * @returns true when the message names Notion *and* asks for an action.
 */
export function shouldTriggerNotion(text: string): boolean {
  if (text.trim() === '') return false
  if (NEGATIVE_PATTERNS.some((pattern) => pattern.test(text))) return false

  const lower = text.toLowerCase()
  const hasNotion = NOTION_ALIASES.some((alias) => lower.includes(alias.toLowerCase()))
  if (!hasNotion) return false

  return INTENT_WORDS.some((word) => text.includes(word))
}

/**
 * Whether a message is a genuine human prompt that may carry the trigger.
 *
 * Commands, injected context, and plugin-authored messages must never trigger a
 * mount, or the plugin would react to its own notices.
 */
export function isTriggerableMessage(message: { source?: { kind?: string } }): boolean {
  return message.source?.kind === 'user'
}
