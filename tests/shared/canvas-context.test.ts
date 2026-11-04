import { describe, expect, it } from 'vitest'
import type {
  CanvasCard,
  CanvasLink,
  CanvasMessageCard,
  CanvasNoteCard
} from '../../src/shared/canvas'
import {
  normalizeCanvasLayout,
  resizeDraftRect,
  sessionCardIds,
  withCanvasContext
} from '../../src/shared/canvas'
import {
  contextExcerpts,
  requestContext,
  sessionContextLinks
} from '../../src/shared/canvas-context'
import { duplicateSelection } from '../../src/shared/canvas-arrange'
import type { Turn } from '../../src/shared/conversation'

const rect = { x: 0, y: 0, w: 400, h: 280 }

function message(id: string, turn: number, parentId?: string): CanvasMessageCard {
  return {
    kind: 'message',
    id,
    rect,
    userTurnId: turn,
    turnId: turn + 1,
    ...(parentId ? { parentId } : {})
  }
}

function exchange(turn: number, question: string, answer: string, error = false): Turn[] {
  return [
    { id: turn, role: 'user', content: question, expansions: [] },
    {
      id: turn + 1,
      role: 'assistant',
      content: answer,
      expansions: [],
      ...(error ? { error } : {})
    }
  ]
}

const note: CanvasNoteCard = { kind: 'note', id: 'note', rect, text: 'Budget is 10k' }

// root -> left, and root -> right -> rightEnd
const cards: CanvasCard[] = [
  message('root', 1),
  message('left', 3, 'root'),
  message('right', 5, 'root'),
  message('rightEnd', 7, 'right'),
  note
]
const turns: Turn[] = [
  ...exchange(1, 'root q', 'root a'),
  ...exchange(3, 'left q', 'left a'),
  ...exchange(5, 'right q', 'right a'),
  ...exchange(7, 'end q', 'end a')
]

function link(
  from: string,
  to: string,
  context?: CanvasLink['context'],
  label?: string
): CanvasLink {
  return {
    id: `${from}>${to}`,
    from,
    to,
    ...(context ? { context } : {}),
    ...(label ? { label } : {})
  }
}

describe('sessionCardIds', () => {
  it('walks from a card up its session', () => {
    expect(sessionCardIds(cards, 'rightEnd')).toEqual(['rightEnd', 'right', 'root'])
    expect(sessionCardIds(cards, undefined)).toEqual([])
  })

  it('survives a stored cycle', () => {
    const looped = [message('a', 1, 'b'), message('b', 3, 'a')]
    expect(sessionCardIds(looped, 'a')).toEqual(['a', 'b'])
  })
})

describe('sessionContextLinks', () => {
  it('ignores plain arrows and reaches everything later on the branch', () => {
    const links = [link('note', 'right', 'card'), link('left', 'right')]
    expect(sessionContextLinks(cards, links, 'rightEnd').map((item) => item.from)).toEqual(['note'])
    expect(sessionContextLinks(cards, links, 'left')).toEqual([])
  })

  it('counts a source linked twice once, as the whole branch', () => {
    const links = [
      { ...link('left', 'rightEnd', 'card'), id: 'a' },
      { ...link('left', 'right', 'branch'), id: 'b' }
    ]
    expect(sessionContextLinks(cards, links, 'rightEnd')).toEqual([
      { from: 'left', context: 'branch' }
    ])
  })
})

describe('requestContext', () => {
  it('sends a linked branch without the history the two branches share', () => {
    const [item] = requestContext(cards, [link('left', 'rightEnd', 'branch')], turns, 'rightEnd')
    expect(item.kind).toBe('branch')
    expect(item.text).toContain('left a')
    expect(item.text).not.toContain('root a')
  })

  it('sends one card alone when asked to', () => {
    const [item] = requestContext(cards, [link('left', 'right', 'card')], turns, 'right')
    expect(item).toEqual({ kind: 'card', title: 'left q', text: 'left a' })
  })

  it('reads a note as it is now and carries the link label', () => {
    const edited = cards.map((card) =>
      card.kind === 'note' ? { ...card, text: 'Budget is 20k' } : card
    )
    const [item] = requestContext(
      edited,
      [link('note', 'right', 'card', 'a limit')],
      turns,
      'right'
    )
    expect(item).toEqual({ kind: 'note', title: '', text: 'Budget is 20k', label: 'a limit' })
  })

  it('sends nothing for a card already in the history', () => {
    expect(requestContext(cards, [link('root', 'right', 'card')], turns, 'right')).toEqual([])
    expect(requestContext(cards, [link('root', 'right', 'branch')], turns, 'right')).toEqual([])
  })

  it('leaves out a failed answer and error text', () => {
    const failed = [...exchange(1, 'root q', 'root a'), ...exchange(3, 'left q', 'boom', true)]
    const linked = [link('left', 'root', 'card')]
    expect(requestContext(cards, linked, failed, 'root')).toEqual([])
    const [branch] = requestContext(
      [message('root', 1), message('left', 3), message('other', 9)],
      [link('left', 'other', 'branch')],
      [...failed, ...exchange(9, 'q', 'a')],
      'other'
    )
    expect(branch.text).toContain('left q')
    expect(branch.text).not.toContain('boom')
  })

  it('skips cards sent another way', () => {
    expect(
      requestContext(cards, [link('note', 'right', 'card')], turns, 'right', ['note'])
    ).toEqual([])
  })

  it('does not follow what fed the linked branch', () => {
    const links = [link('left', 'right', 'branch'), link('note', 'left', 'card')]
    const items = requestContext(cards, links, turns, 'right')
    expect(items.map((item) => item.kind)).toEqual(['branch'])
  })
})

describe('contextExcerpts limits', () => {
  const long = 'x'.repeat(50000)

  it('keeps the newest part of a long branch and says it was cut', () => {
    const tail = [message('long', 1), message('other', 3)]
    const result = contextExcerpts(
      tail,
      [...exchange(1, 'q', `${long}END`), ...exchange(3, 'q2', 'a2')],
      [{ from: 'long', context: 'branch' }],
      []
    )
    expect(result.clipped).toBe(true)
    expect(result.items[0].text.endsWith('END')).toBe(true)
    expect(result.items[0].text.length).toBeLessThan(13000)
  })

  it('stops at the total limit, nearest links first', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((id, i) => message(id, i * 2 + 1))
    const manyTurns = many.flatMap((_, i) => exchange(i * 2 + 1, 'q', long))
    const result = contextExcerpts(
      many,
      manyTurns,
      many.map((card) => ({ from: card.id, context: 'branch' as const })),
      []
    )
    const total = result.items.reduce((sum, item) => sum + item.text.length, 0)
    expect(result.clipped).toBe(true)
    expect(total).toBeLessThanOrEqual(24000 + result.items.length)
    expect(result.items).toHaveLength(2)
  })
})

describe('withCanvasContext', () => {
  it('goes on the newest user message and nowhere else', () => {
    const messages = [
      { role: 'system' as const, content: 's' },
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: 'a' },
      { role: 'user' as const, content: 'second' }
    ]
    const sent = withCanvasContext(messages, [{ kind: 'note', title: '', text: 'Budget is 10k' }])
    expect(sent[1].content).toBe('first')
    expect(sent[3].content).toContain('<note>\nBudget is 10k\n</note>')
    expect(sent[3].content.endsWith('second')).toBe(true)
    expect(withCanvasContext(messages, [])).toBe(messages)
  })
})

describe('stored links', () => {
  it('keep a valid context and drop anything else', () => {
    const layout = normalizeCanvasLayout(
      {
        cards,
        links: [link('left', 'right', 'branch'), { ...link('note', 'right'), context: 'bogus' }]
      },
      turns
    )
    expect(layout.links[0].context).toBe('branch')
    expect(layout.links[1]).not.toHaveProperty('context')
  })

  it('follow a duplicate when they send context', () => {
    let counter = 100
    const copy = duplicateSelection(
      { cards, frames: [], links: [link('note', 'left', 'card'), link('root', 'left')] },
      turns,
      new Set(['left']),
      { newId: () => `new${++counter}`, newTurnId: () => ++counter, streamingTurnIds: new Set() }
    )
    // The note was not selected, but the copy still reads it; a plain arrow stays behind.
    expect(copy?.links).toHaveLength(1)
    expect(copy?.links[0]).toMatchObject({ from: 'note', context: 'card' })
  })
})

describe('resizeDraftRect', () => {
  const start = { x: 100, y: 100, w: 400, h: 280 }

  it('grows from the far corner and snaps only the moving edges', () => {
    const near = { x: 511, y: 1000, w: 100, h: 100 }
    const { rect, guidesX } = resizeDraftRect(start, undefined, { dw: 5, dh: 20 }, [near], 10)
    expect(rect).toEqual({ x: 100, y: 100, w: 411, h: 300 })
    expect(guidesX).toEqual([511])
  })

  it('stays against a parent on its left or top side', () => {
    const left = resizeDraftRect(start, 'left', { dw: 50, dh: 0 }, [], 0).rect
    expect(left.x + left.w).toBe(500)
    expect(left.x).toBe(50)
    const top = resizeDraftRect(start, 'top', { dw: 0, dh: 50 }, [], 0).rect
    expect(top.y + top.h).toBe(380)
    expect(top.y).toBe(50)
  })

  it('never goes under the minimum size', () => {
    const { rect } = resizeDraftRect(start, undefined, { dw: -2000, dh: -2000 }, [], 0)
    expect(rect).toEqual({ x: 100, y: 100, w: 200, h: 120 })
  })

  it('grows over what stands in the way', () => {
    const wall = { x: 600, y: 0, w: 100, h: 1000 }
    const { rect } = resizeDraftRect(start, undefined, { dw: 500, dh: 40 }, [wall], 0)
    expect(rect.w).toBe(900)
    expect(rect.h).toBe(320)
  })
})
