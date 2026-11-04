import { describe, expect, it } from 'vitest'
import type { CanvasCard } from '../../src/shared/canvas'
import type { CanvasRecord, ConversationRecord, Turn } from '../../src/shared/conversation'
import { migrateConversationRecord } from '../../src/shared/conversation'
import type { LegacyTurn } from '../../src/shared/rich-text'
import { buildSingleMaterial } from '../../src/main/kb/analysis'

function legacyRecord(turns: LegacyTurn[]): ConversationRecord {
  return {
    id: 'kb1',
    title: 'KB',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    source: 'chat',
    state: { turns },
    kbFed: false
  } as unknown as ConversationRecord
}

function turn(id: number, role: Turn['role'], content: string): Turn {
  return { id, role, content, expansions: [] }
}

function chatRecord(turns: Turn[]): ConversationRecord {
  return {
    id: 'kb2',
    title: 'KB',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    source: 'chat',
    state: { turns },
    kbFed: false
  }
}

function canvasRecord(turns: Turn[], cards: CanvasCard[]): CanvasRecord {
  const record = chatRecord(turns)
  return {
    ...record,
    source: 'canvas',
    state: { turns },
    canvas: { cards, viewport: { x: 0, y: 0, zoom: 1 } } as CanvasRecord['canvas']
  }
}

/** Exchange `n` uses turn ids `2n` and `2n + 1`. */
function exchangeTurns(...numbers: number[]): Turn[] {
  return numbers.flatMap((n) => [
    turn(2 * n, 'user', `question ${n}`),
    turn(2 * n + 1, 'assistant', `answer ${n}`)
  ])
}

function messageCard(id: string, n: number, parentId?: string): CanvasCard {
  return {
    kind: 'message',
    id,
    rect: { x: 0, y: 0, w: 100, h: 100 },
    userTurnId: 2 * n,
    turnId: 2 * n + 1,
    ...(parentId !== undefined ? { parentId } : {})
  }
}

describe('buildSingleMaterial', () => {
  it('reads migrated expansion fields, including nested answers', () => {
    const record = migrateConversationRecord(
      legacyRecord([
        {
          id: 1,
          role: 'assistant',
          content: 'ignored',
          segments: [
            { kind: 'text', text: 'Alpha ' },
            {
              kind: 'expansion',
              expansionId: 1,
              originalText: 'beta',
              cachedText: 'discarded when children exist',
              prompt: 'more',
              folded: false,
              segments: [
                { kind: 'text', text: 'beta ' },
                {
                  kind: 'expansion',
                  expansionId: 2,
                  originalText: 'one',
                  cachedText: 'child answer',
                  folded: false,
                  segments: []
                }
              ]
            }
          ]
        }
      ])
    )

    const material = buildSingleMaterial(record)

    expect(material).toContain('Expanded terms:')
    expect(material).toContain('- Context: Alpha beta')
    expect(material).toContain('  Term: "beta"')
    expect(material).toContain('  Answer: beta one')
    expect(material).toContain('  User asked: "more"')
    expect(material).toContain('  Term: "one"')
    expect(material).toContain('  Answer: child answer')
  })

  it('omits the expansion section when no turn has expansions', () => {
    const record = migrateConversationRecord(
      legacyRecord([
        { id: 1, role: 'user', content: 'what is X' },
        { id: 2, role: 'assistant', content: 'X is Y' }
      ])
    )

    const material = buildSingleMaterial(record)

    expect(material).toContain('Questions:')
    expect(material).toContain('- User: what is X\n  Assistant: X is Y')
    expect(material).not.toContain('Thread 1')
    expect(material).not.toContain('Expanded terms:')
  })

  it('truncates a long expansion answer to 300 characters', () => {
    const long = 'x'.repeat(350)
    const record = migrateConversationRecord(
      legacyRecord([
        {
          id: 1,
          role: 'assistant',
          content: '',
          segments: [
            { kind: 'text', text: 'Term ' },
            {
              kind: 'expansion',
              expansionId: 1,
              originalText: 'term',
              cachedText: long,
              folded: false,
              segments: []
            }
          ]
        }
      ])
    )

    const material = buildSingleMaterial(record)
    expect(material).toContain('  Answer: ' + 'x'.repeat(300) + '...')
    expect(material).not.toContain('x'.repeat(301))
  })

  it('includes the newest answer and skips failed ones', () => {
    const material = buildSingleMaterial(
      chatRecord([
        turn(1, 'user', 'first'),
        { ...turn(2, 'assistant', 'Request failed: 500'), error: true },
        turn(3, 'user', 'second'),
        turn(4, 'assistant', 'the newest answer')
      ])
    )

    expect(material).not.toContain('Request failed')
    expect(material).toContain('- User: second\n  Assistant: the newest answer')
  })

  it('pairs each canvas question with its own answer, not the last one created', () => {
    const material = buildSingleMaterial(
      canvasRecord(exchangeTurns(1, 2), [messageCard('a', 1), messageCard('b', 2)])
    )

    expect(material).toContain(
      [
        'Thread 1:',
        '- User: question 1',
        '  Assistant: answer 1',
        'Thread 2:',
        '- User: question 2',
        '  Assistant: answer 2'
      ].join('\n')
    )
  })

  it('shows a fork once, with each branch continuing the shared history', () => {
    const material = buildSingleMaterial(
      canvasRecord(exchangeTurns(1, 2, 3, 4), [
        messageCard('root', 1),
        messageCard('left', 2, 'root'),
        messageCard('right', 3, 'root'),
        messageCard('after-left', 4, 'left')
      ])
    )

    expect(material).toContain(
      [
        'Thread 1:',
        '- User: question 1',
        '  Assistant: answer 1',
        'Thread 2 (continues Thread 1):',
        '- User: question 2',
        '  Assistant: answer 2',
        '- User: question 4',
        '  Assistant: answer 4',
        'Thread 3 (continues Thread 1):',
        '- User: question 3',
        '  Assistant: answer 3'
      ].join('\n')
    )
    expect(material.match(/question 1/g)).toHaveLength(1)
  })

  it('keeps a canvas with a single line of cards free of thread labels', () => {
    const material = buildSingleMaterial(
      canvasRecord(exchangeTurns(1, 2), [messageCard('a', 1), messageCard('b', 2, 'a')])
    )

    expect(material).not.toContain('Thread')
    expect(material).toContain('- User: question 2\n  Assistant: answer 2')
  })

  it('loses nothing when the stored canvas links or layout cannot be trusted', () => {
    const cyclic = buildSingleMaterial(
      canvasRecord(exchangeTurns(1, 2), [messageCard('a', 1, 'b'), messageCard('b', 2, 'a')])
    )
    expect(cyclic).toContain('question 1')
    expect(cyclic).toContain('question 2')

    const unplaced = buildSingleMaterial(canvasRecord(exchangeTurns(1, 2), []))
    expect(unplaced).toContain('question 1')
    expect(unplaced).toContain('answer 2')
  })
})
