import { describe, it, expect } from 'vitest'
import { shouldTriggerNotion, messageText, isTriggerableMessage } from '../src/notion-trigger.js'

describe('shouldTriggerNotion', () => {
  describe('triggers on Notion + action intent', () => {
    const cases = [
      '看一下notion中今天的待办有哪些',
      '分析当前架构并记录到notion中',
      '帮我查一下 notion 里的项目文档',
      '把这次评审结论写入 Notion',
      'Notion 数据库里有多少条记录？',
      '看看 notion 上这个页面的评论',
      '整理一下 notion 的会议笔记',
      '同步到 notion',
      '从 notion 读取需求文档',
      '搜索 notion 中的设计稿',
    ]
    for (const text of cases) {
      it(`"${text}"`, () => expect(shouldTriggerNotion(text)).toBe(true))
    }
  })

  describe('does not trigger without an action intent', () => {
    const cases = [
      'notion 和飞书的区别是什么',
      'notion 是什么',
      '什么是 notion',
      'notion 怎么用',
      'notion 这个产品挺有意思',
      'NOTION 的公司文化',
    ]
    for (const text of cases) {
      it(`"${text}"`, () => expect(shouldTriggerNotion(text)).toBe(false))
    }
  })

  describe('does not trigger on an action without Notion', () => {
    const cases = [
      '看一下今天的待办',
      '帮我查一下项目文档',
      '分析当前架构并记录到本地文件',
      '总结一下这次会议',
      '把这个写入 README',
    ]
    for (const text of cases) {
      it(`"${text}"`, () => expect(shouldTriggerNotion(text)).toBe(false))
    }
  })

  describe('honors explicit opt-out phrasing', () => {
    const cases = [
      '不要用 notion，直接写在本地',
      '别用 notion 了',
      '无需连接 notion',
      '这次不用 notion，我们手动整理',
    ]
    for (const text of cases) {
      it(`"${text}"`, () => expect(shouldTriggerNotion(text)).toBe(false))
    }
  })

  it('is case-insensitive on the Latin name', () => {
    expect(shouldTriggerNotion('查一下 NOTION 里的文档')).toBe(true)
    expect(shouldTriggerNotion('查一下 Notion 里的文档')).toBe(true)
  })

  it('ignores empty and whitespace input', () => {
    expect(shouldTriggerNotion('')).toBe(false)
    expect(shouldTriggerNotion('   \n  ')).toBe(false)
  })

  it('triggers regardless of where notion appears in the sentence', () => {
    expect(shouldTriggerNotion('notion 里今天的待办看一下')).toBe(true)
    expect(shouldTriggerNotion('记到 notion')).toBe(true)
  })
})

describe('messageText', () => {
  it('joins text blocks and ignores non-text blocks', () => {
    const message = {
      content: [
        { type: 'text', text: '第一段' },
        { type: 'image', data: 'xx' },
        { type: 'text', text: '第二段' },
      ],
    }
    expect(messageText(message)).toBe('第一段\n第二段')
  })

  it('returns empty for missing or malformed content', () => {
    expect(messageText({})).toBe('')
    expect(messageText({ content: 'nope' })).toBe('')
    expect(messageText({ content: [null, 3, { type: 'image' }] })).toBe('')
  })
})

describe('isTriggerableMessage', () => {
  it('accepts only genuine user messages', () => {
    expect(isTriggerableMessage({ source: { kind: 'user' } })).toBe(true)
    expect(isTriggerableMessage({ source: { kind: 'system' } })).toBe(false)
    expect(isTriggerableMessage({ source: { kind: 'goal' } })).toBe(false)
    expect(isTriggerableMessage({})).toBe(false)
  })
})
