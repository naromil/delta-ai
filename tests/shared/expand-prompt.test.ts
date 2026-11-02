import { describe, expect, it } from 'vitest'
import type { ConversationState, Turn } from '../../src/shared/conversation'
import {
  EXPAND_HISTORY_MESSAGES,
  buildExpandMessages,
  buildExpandRequest
} from '../../src/shared/expand-prompt'
import {
  EXPAND_DEFAULT_PROMPT,
  buildExpandPromptedInstruction,
  buildExpandUserInstruction,
  isTermSelection
} from '../../src/shared/prompts'
import type { ExpansionNode } from '../../src/shared/rich-text'

function frame(id: number, overrides: Partial<ExpansionNode>): ExpansionNode {
  return {
    id,
    start: 0,
    end: 5,
    originalText: 'alpha',
    answer: '',
    status: 'done',
    folded: false,
    children: [],
    ...overrides
  }
}

function userTurn(id: number, content: string, extra: Partial<Turn> = {}): Turn {
  return { id, role: 'user', content, expansions: [], ...extra }
}

function assistantTurn(id: number, content: string, extra: Partial<Turn> = {}): Turn {
  return { id, role: 'assistant', content, expansions: [], ...extra }
}

describe('isTermSelection', () => {
  it('treats a few words as a term and a sentence or code as a passage', () => {
    expect(isTermSelection('HKUMed')).toBe(true)
    expect(isTermSelection('  context window size ')).toBe(true)
    expect(isTermSelection('v1.2')).toBe(true)
    expect(isTermSelection('this is five words long')).toBe(false)
    expect(isTermSelection('It failed.')).toBe(false)
    expect(isTermSelection('one\ntwo')).toBe(false)
    expect(isTermSelection('```js\nx\n```')).toBe(false)
  })
})

describe('expand instructions', () => {
  it('defines a term and explains a passage', () => {
    expect(buildExpandUserInstruction('HKUMed')).toContain('define "HKUMed"')
    expect(buildExpandUserInstruction('HKUMed')).toContain('bare phrase')
    const passage = 'The cache misses because the key changed.'
    expect(buildExpandUserInstruction(passage)).toContain('explained')
    expect(buildExpandUserInstruction(passage)).not.toContain('bare phrase')
  })

  it('carries the question and falls back to the default when it is blank', () => {
    expect(buildExpandPromptedInstruction('x', 'Why?')).toContain('"Why?"')
    expect(buildExpandPromptedInstruction('x', '  ')).toContain(EXPAND_DEFAULT_PROMPT)
  })
})

describe('buildExpandMessages', () => {
  it('stays the answer plus the instruction without further context', () => {
    const messages = buildExpandMessages({ answer: 'alpha beta', selection: 'beta' })
    expect(messages.map((message) => message.role)).toEqual(['assistant', 'user'])
    expect(messages[0].content).toBe('alpha beta')
  })
})

describe('buildExpandRequest', () => {
  const question = userTurn(1, 'What is alpha?')
  const answer = assistantTurn(2, 'alpha beta gamma')

  it('sends the question that led to the answer', () => {
    const state: ConversationState = { turns: [question, answer] }
    const messages = buildExpandRequest(state, answer, undefined, { start: 6, end: 10 }, 'chat')
    expect(messages?.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user'
    ])
    expect(messages?.[1].content).toBe('What is alpha?')
    expect(messages?.[2].content).toBe('alpha beta gamma')
    expect(messages?.[3].content).toContain('"beta"')
  })

  it('leaves out turns after the answer, failed turns and images', () => {
    const image = { name: 'a.jpg', mediaType: 'image/jpeg', data: 'AAAA' } as never
    const state: ConversationState = {
      turns: [
        userTurn(1, '', { attachments: [image] }),
        assistantTurn(2, 'boom', { error: true }),
        userTurn(3, 'with image', { attachments: [image] }),
        answer,
        userTurn(4, 'a later question')
      ]
    }
    const messages = buildExpandRequest(state, answer, undefined, { start: 0, end: 5 }, 'chat')
    const text = JSON.stringify(messages)
    expect(text).not.toContain('a later question')
    expect(text).not.toContain('boom')
    expect(text).not.toContain('AAAA')
    expect(messages?.some((message) => message.content === '')).toBe(false)
  })

  it('keeps the screen context and only the newest history', () => {
    const turns: Turn[] = []
    for (let i = 0; i < 20; i++) turns.push(userTurn(100 + i, `message ${i}`))
    const state: ConversationState = { context: 'screen text', turns: [...turns, answer] }
    const messages = buildExpandRequest(state, answer, undefined, { start: 0, end: 5 }, 'lookup')
    expect(messages?.[1].content).toContain('screen text')
    const history = messages?.filter((message) => message.content.startsWith('message ')) ?? []
    expect(history).toHaveLength(EXPAND_HISTORY_MESSAGES)
    expect(history[history.length - 1].content).toBe('message 19')
  })

  it('walks a nested selection up through every ancestor', () => {
    const inner = frame(2, {
      start: 0,
      end: 4,
      originalText: 'beta',
      prompt: 'Why?',
      answer: 'gamma delta'
    })
    const outer = frame(1, { answer: 'beta explained', children: [inner] })
    const nested = assistantTurn(2, 'alpha is here', { expansions: [outer] })
    const state: ConversationState = { turns: [question, nested] }

    const messages = buildExpandRequest(state, nested, 2, { start: 0, end: 5 }, 'chat')
    expect(messages?.map((message) => message.content.slice(0, 14))).toEqual([
      expect.any(String),
      'What is alpha?',
      'alpha is here',
      'What does "alp',
      'beta explained',
      'About "beta" f',
      'gamma delta',
      expect.any(String)
    ])
    expect(messages?.[messages.length - 1].content).toContain('"gamma"')
  })

  it('refuses a range or parent that no longer exists', () => {
    const state: ConversationState = { turns: [question, answer] }
    expect(buildExpandRequest(state, answer, undefined, { start: 0, end: 999 }, 'chat')).toBeNull()
    expect(buildExpandRequest(state, answer, 42, { start: 0, end: 1 }, 'chat')).toBeNull()
  })
})
