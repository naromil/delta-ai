import { describe, expect, it } from 'vitest'
import type { ConversationState } from '../../src/shared/conversation'
import type { ExpansionNode } from '../../src/shared/rich-text'
import { prepareTransferredState } from '../../src/main/transfer'
import { buildScreenContextMessage } from '../../src/shared/prompts'

function node(id: number, overrides: Partial<ExpansionNode> = {}): ExpansionNode {
  return {
    id,
    start: 0,
    end: 1,
    originalText: 'x',
    answer: '',
    status: 'done',
    folded: false,
    children: [],
    ...overrides
  }
}

function state(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    turns: [
      {
        id: 1,
        role: 'assistant',
        content: 'alpha',
        expansions: [
          node(1, {
            status: 'loading',
            children: [node(2, { status: 'loading', answer: 'partial' })]
          })
        ]
      }
    ],
    ...overrides
  }
}

describe('prepareTransferredState', () => {
  it('finalises in-flight frames before the state leaves the lookup window', () => {
    const input = state()
    const transferred = prepareTransferredState(input)

    expect(transferred.turns[0].expansions[0].status).toBe('error')
    expect(transferred.turns[0].expansions[0].children[0].status).toBe('error')
    expect(transferred.turns[0].expansions[0].children[0].answer).toBe('partial')

    // Pure: the caller's live state keeps streaming.
    expect(input.turns[0].expansions[0].status).toBe('loading')
  })

  it('folds the screen context into a leading user turn', () => {
    const transferred = prepareTransferredState(state({ context: 'screen text' }))

    expect(transferred.context).toBe('')
    expect(transferred.turns).toHaveLength(2)
    expect(transferred.turns[0]).toMatchObject({
      role: 'user',
      content: buildScreenContextMessage('screen text'),
      expansions: []
    })
    expect(transferred.turns[1].role).toBe('assistant')
  })

  it('leaves turns alone when there is no context', () => {
    const transferred = prepareTransferredState(state())
    expect(transferred.turns).toHaveLength(1)
    expect(transferred.context).toBeUndefined()
  })
})
