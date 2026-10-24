import { describe, expect, it, vi } from 'vitest'
import type { ConversationRecord, ExpansionNode } from '../../src/shared/conversation'

vi.mock('electron', () => ({
  app: { getPath: (): string => '' },
  BrowserWindow: { getFocusedWindow: (): null => null },
  dialog: { showSaveDialog: vi.fn() }
}))

import { renderConversationMarkdown } from '../../src/main/conversation-export'

function expansion(overrides: Partial<ExpansionNode> = {}): ExpansionNode {
  return {
    id: 1,
    start: 0,
    end: 4,
    originalText: 'term',
    answer: 'expanded answer',
    status: 'done',
    folded: false,
    children: [],
    ...overrides
  }
}

function record(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: 'abc',
    title: 'Budget talk',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    source: 'chat',
    state: {
      turns: [
        { id: 1, role: 'user', content: 'Hello', expansions: [] },
        { id: 2, role: 'assistant', content: 'Hi there', expansions: [] }
      ]
    },
    kbFed: false,
    ...overrides
  }
}

describe('renderConversationMarkdown', () => {
  it('renders the title, timestamps and turn headings', () => {
    expect(renderConversationMarkdown(record())).toBe(
      [
        '# Budget talk',
        '',
        '_Created 2026-01-01T00:00:00.000Z · Updated 2026-01-02T00:00:00.000Z_',
        '',
        '## You',
        'Hello',
        '',
        '## Delta AI',
        'Hi there',
        ''
      ].join('\n')
    )
  })

  it('ends with exactly one trailing newline', () => {
    const markdown = renderConversationMarkdown(record())
    expect(markdown.endsWith('\n')).toBe(true)
    expect(markdown.endsWith('\n\n')).toBe(false)
  })

  it('quotes each top-level expansion after its turn, including folded ones', () => {
    const markdown = renderConversationMarkdown(
      record({
        state: {
          turns: [
            { id: 1, role: 'user', content: 'What is term?', expansions: [] },
            {
              id: 2,
              role: 'assistant',
              content: 'Answer',
              expansions: [expansion({ answer: 'Line one\nLine two', folded: true })]
            }
          ]
        }
      })
    )

    expect(markdown).toContain('Answer\n\n> **Expansion on “term”**\n> Line one\n> Line two\n')
  })

  it('appends the custom prompt to the expansion header', () => {
    const markdown = renderConversationMarkdown(
      record({
        state: {
          turns: [
            {
              id: 1,
              role: 'assistant',
              content: 'Answer',
              expansions: [expansion({ prompt: 'simpler' })]
            }
          ]
        }
      })
    )

    expect(markdown).toContain('> **Expansion on “term”** — simpler\n> expanded answer')
  })

  it('nests child expansions one quote level deeper', () => {
    const markdown = renderConversationMarkdown(
      record({
        state: {
          turns: [
            {
              id: 1,
              role: 'assistant',
              content: 'Answer',
              expansions: [
                expansion({
                  answer: 'parent',
                  children: [expansion({ id: 2, originalText: 'inner', answer: 'child text' })]
                })
              ]
            }
          ]
        }
      })
    )

    expect(markdown).toContain(
      [
        '> **Expansion on “term”**',
        '> parent',
        '> > **Expansion on “inner”**',
        '> > child text'
      ].join('\n')
    )
  })

  it('skips failed and blank assistant turns together with their expansions', () => {
    const markdown = renderConversationMarkdown(
      record({
        state: {
          turns: [
            { id: 1, role: 'user', content: 'Question', expansions: [] },
            {
              id: 2,
              role: 'assistant',
              content: 'API error text',
              error: true,
              expansions: [expansion({ originalText: 'broken' })]
            },
            {
              id: 3,
              role: 'assistant',
              content: '   ',
              expansions: [expansion({ originalText: 'blank' })]
            },
            { id: 4, role: 'assistant', content: 'Real answer', expansions: [] }
          ]
        }
      })
    )

    expect(markdown).not.toContain('API error text')
    expect(markdown).not.toContain('broken')
    expect(markdown).not.toContain('blank')
    expect(markdown).toContain('## Delta AI\nReal answer')
    expect(markdown.match(/## Delta AI/g)).toHaveLength(1)
  })
})
