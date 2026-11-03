import { describe, expect, it } from 'vitest'
import type {
  CanvasCard,
  CanvasExpansionCard,
  CanvasFrame,
  CanvasLink,
  CanvasMessageCard,
  CanvasNoteCard,
  CanvasRect
} from '../../src/shared/canvas'
import {
  askedAboutRelations,
  canvasContinuations,
  COLLAPSED_CARD_HEIGHT,
  connectorGeometry,
  continuationCandidates,
  fitCardHeight,
  hiddenInsetIds,
  normalizeCanvasLayout,
  openCardSize,
  rectsOverlap,
  setCardCollapsed,
  turnsThroughCard,
  withCanvasSources
} from '../../src/shared/canvas'
import {
  alignSelection,
  distributeSelection,
  duplicateSelection,
  selectionBlockCount,
  tidySelection
} from '../../src/shared/canvas-arrange'
import type { CanvasSnapshot } from '../../src/shared/canvas-history'
import { applyCanvasPatch, diffCanvas } from '../../src/shared/canvas-history'
import { canvasOutline, searchCanvasOutline } from '../../src/shared/canvas-outline'
import {
  cardAtPoint,
  marqueeHits,
  movingForSelection,
  selectionMarkdown,
  sessionAncestorIds,
  sharedColor,
  sourceExcerpts
} from '../../src/shared/canvas-selection'
import type { Turn } from '../../src/shared/conversation'
import type { ExpansionNode } from '../../src/shared/rich-text'

const rect = (x: number, y: number, w = 100, h = 100): CanvasRect => ({ x, y, w, h })

function message(id: string, turn: number, at: CanvasRect, parentId?: string): CanvasMessageCard {
  return {
    kind: 'message',
    id,
    rect: at,
    userTurnId: turn,
    turnId: turn + 1,
    ...(parentId ? { parentId } : {})
  }
}

function inset(id: string, hostId: string, at: CanvasRect, expansionId = 7): CanvasExpansionCard {
  return { kind: 'expansion', id, rect: at, turnId: 2, expansionId, hostId, inset: true }
}

function note(id: string, at: CanvasRect, text = 'a thought'): CanvasNoteCard {
  return { kind: 'note', id, rect: at, text }
}

function frame(id: string, at: CanvasRect, title = 'Group'): CanvasFrame {
  return { id, rect: at, title }
}

function turnsFor(...ids: number[]): Turn[] {
  return ids.flatMap((id): Turn[] => [
    { id, role: 'user', content: `question ${id}`, expansions: [] },
    { id: id + 1, role: 'assistant', content: `answer ${id}`, expansions: [] }
  ])
}

function snapshot(
  cards: CanvasCard[],
  turns: Turn[] = [],
  extra: { frames?: CanvasFrame[]; links?: CanvasLink[] } = {}
): CanvasSnapshot {
  return { cards, turns, frames: extra.frames ?? [], links: extra.links ?? [] }
}

const expansionNode: ExpansionNode = {
  id: 7,
  start: 0,
  end: 3,
  originalText: 'ans',
  answer: 'expanded',
  status: 'done',
  folded: false,
  children: []
}

describe('selecting', () => {
  it('catches what a marquee touches, but a frame only when wholly covered', () => {
    const cards = [message('a', 1, rect(0, 0)), note('n', rect(300, 0))]
    const frames = [frame('f', rect(-20, -20, 200, 200)), frame('g', rect(600, 0, 50, 50))]
    expect(marqueeHits({ cards, frames }, rect(50, 50, 10, 10))).toEqual(['a'])
    expect(marqueeHits({ cards, frames }, rect(-50, -50, 800, 400)).sort()).toEqual([
      'a',
      'f',
      'g',
      'n'
    ])
  })

  it('never catches a card drawn over text, as it rides on its host', () => {
    const cards = [message('a', 1, rect(0, 0, 400, 400)), inset('i', 'a', rect(10, 10, 80, 80))]
    expect(marqueeHits({ cards, frames: [] }, rect(0, 0, 50, 50))).toEqual(['a'])
  })

  it('finds a card drawn over text before the card it sits on', () => {
    const cards = [message('a', 1, rect(0, 0, 400, 400)), inset('i', 'a', rect(10, 10, 80, 80))]
    expect(cardAtPoint(cards, { x: 20, y: 20 })?.id).toBe('i')
    expect(cardAtPoint(cards, { x: 300, y: 300 })?.id).toBe('a')
    expect(cardAtPoint(cards, { x: 900, y: 900 })).toBeUndefined()
  })

  it('shows a colour as chosen only when the whole selection shares it', () => {
    const red = { ...note('a', rect(0, 0)), color: 'red' as const }
    const alsoRed = { ...note('b', rect(200, 0)), color: 'red' as const }
    const plain = note('c', rect(400, 0))
    const items = { cards: [red, alsoRed, plain], frames: [] }
    expect(sharedColor(items, new Set(['a', 'b']))).toBe('red')
    expect(sharedColor(items, new Set(['a', 'c']))).toBeUndefined()
  })
})

describe('what a selection carries when dragged', () => {
  it('brings cards joined to a selected one, so a session stays in one piece', () => {
    const cards = [message('a', 1, rect(0, 0)), message('b', 3, rect(100, 0), 'a')]
    const moving = movingForSelection({ cards, frames: [] }, new Set(['a']))
    expect([...moving.cards].sort()).toEqual(['a', 'b'])
  })

  it('pulls a card off its parent with its attached descendants only', () => {
    const cards = [
      message('parent', 1, rect(0, 0)),
      message('pulled', 3, rect(100, 0), 'parent'),
      message('child', 5, rect(200, 0), 'pulled'),
      message('grandchild', 7, rect(300, 0), 'child'),
      inset('over', 'pulled', rect(110, 10, 40, 40), 9),
      { ...inset('touching', 'pulled', rect(100, 100), 11), inset: false },
      { ...inset('linked', 'pulled', rect(500, 500), 13), inset: false },
      message('linkedChild', 15, rect(900, 0), 'pulled'),
      message('beyondLink', 17, rect(1000, 0), 'linkedChild'),
      message('neighbour', 19, rect(100, -100))
    ]
    const moving = movingForSelection({ cards, frames: [] }, new Set(['pulled']), true)
    expect([...moving.cards].sort()).toEqual(
      ['child', 'grandchild', 'over', 'pulled', 'touching'].sort()
    )
  })

  it('leaves a child joined to its parent only through a third card', () => {
    const cards = [
      message('pulled', 1, rect(0, 0)),
      message('between', 3, rect(100, 0)),
      message('child', 5, rect(200, 0), 'pulled')
    ]
    const moving = movingForSelection({ cards, frames: [] }, new Set(['pulled']), true)
    expect([...moving.cards]).toEqual(['pulled'])
  })

  it('takes what stands inside a frame, nested frames included', () => {
    const cards = [message('in', 1, rect(10, 10)), message('out', 3, rect(900, 0))]
    const frames = [frame('outer', rect(0, 0, 500, 500)), frame('inner', rect(200, 200, 100, 100))]
    const moving = movingForSelection({ cards, frames }, new Set(['outer']))
    expect([...moving.cards]).toEqual(['in'])
    expect([...moving.frames].sort()).toEqual(['inner', 'outer'])
  })

  it('leaves behind a frame whose card is dragged out of it', () => {
    const cards = [message('in', 1, rect(10, 10))]
    const frames = [frame('f', rect(0, 0, 500, 500))]
    expect([...movingForSelection({ cards, frames }, new Set(['in'])).frames]).toEqual([])
  })

  it('does not carry an inset card off a host that is staying', () => {
    const cards = [
      message('host', 1, rect(0, 0, 400, 400)),
      inset('i', 'host', rect(10, 10, 80, 80)),
      message('other', 3, rect(900, 0))
    ]
    const moving = movingForSelection({ cards, frames: [] }, new Set(['i', 'other']))
    expect([...moving.cards]).toEqual(['other'])
  })
})

describe('session paths', () => {
  it('walks back through expansions and continuations to the root', () => {
    const cards = [
      message('a', 1, rect(0, 0)),
      message('b', 3, rect(0, 100), 'a'),
      inset('i', 'b', rect(0, 110, 50, 50))
    ]
    expect([...sessionAncestorIds(cards, 'i')]).toEqual(['b', 'a'])
    expect([...sessionAncestorIds(cards, 'a')]).toEqual([])
  })

  it('survives a stored cycle', () => {
    const cards = [message('a', 1, rect(0, 0), 'b'), message('b', 3, rect(200, 0), 'a')]
    expect([...sessionAncestorIds(cards, 'a')]).toEqual(['b'])
  })
})

describe('notes', () => {
  it('are never offered as a session to continue', () => {
    const cards = [note('n', rect(0, 0)), message('m', 1, rect(0, 100))]
    const drawn = rect(100, 0, 100, 200)
    expect(continuationCandidates(drawn, cards).map((card) => card.id)).toEqual(['m'])
  })

  it('send no history of their own', () => {
    expect(turnsThroughCard([note('n', rect(0, 0))], [], 'n')).toEqual([])
  })

  it('keep the size they were given when an answer finishes', () => {
    expect(fitCardHeight([note('n', rect(0, 0))], 'n', 900)).toEqual([])
  })
})

describe('asking about cards', () => {
  it('sends their text with the newest question, in reading order', () => {
    const cards = [note('low', rect(0, 500), 'below'), message('m', 1, rect(0, 0))]
    const excerpts = sourceExcerpts(cards, turnsFor(1), ['low', 'm'])
    expect(excerpts).toEqual([
      { title: 'question 1', text: 'answer 1' },
      { title: '', text: 'below' }
    ])
    const messages = withCanvasSources(
      [
        { role: 'user', content: 'old' },
        { role: 'assistant', content: 'older' },
        { role: 'user', content: 'What links these?' }
      ],
      excerpts
    )
    expect(messages[0].content).toBe('old')
    expect(messages[2].content).toContain('answer 1')
    expect(messages[2].content).toContain('below')
    expect(messages[2].content.endsWith('What links these?')).toBe(true)
  })

  it('clips a very long card, so one card cannot crowd out the question', () => {
    const excerpts = sourceExcerpts([note('n', rect(0, 0), 'x'.repeat(20000))], [], ['n'])
    expect(excerpts[0].text.length).toBeLessThan(6100)
  })

  it('changes nothing when there is nothing to send', () => {
    const messages = [{ role: 'user' as const, content: 'q' }]
    expect(withCanvasSources(messages, [])).toBe(messages)
  })

  it('draws a line from each card asked about, and none for a session', () => {
    const asked: CanvasMessageCard = { ...message('q', 5, rect(500, 0)), sources: ['n', 'gone'] }
    const cards = [
      note('n', rect(0, 0)),
      message('far', 1, rect(0, 300)),
      message('child', 3, rect(800, 800), 'far'),
      message('touching', 7, rect(800, 900), 'child'),
      asked
    ]
    expect(askedAboutRelations(cards)).toEqual([{ from: 'n', to: 'q' }])
  })
})

describe('lines the canvas draws by itself', () => {
  it('leaves the card continued to its own mark when it is also a card asked about', () => {
    const asked: CanvasMessageCard = {
      ...message('q', 5, rect(900, 900), 'far'),
      sources: ['far']
    }
    expect(askedAboutRelations([message('far', 1, rect(0, 0)), asked])).toEqual([])
    expect(canvasContinuations([message('far', 1, rect(0, 0)), asked])).toHaveLength(1)
  })
})

describe('collapsing', () => {
  it('shrinks to a title, brings what is below up, and returns on expanding', () => {
    const cards = [message('a', 1, rect(0, 0, 100, 300)), message('b', 3, rect(0, 300), 'a')]
    const closed = setCardCollapsed(cards, 'a', true)
    expect(closed[0].rect.h).toBe(COLLAPSED_CARD_HEIGHT)
    expect(closed[1].rect.y).toBe(COLLAPSED_CARD_HEIGHT)
    expect(openCardSize(closed[0]).h).toBe(300)

    const open = setCardCollapsed(closed, 'a', false)
    expect(open[0].rect.h).toBe(300)
    expect(open[1].rect.y).toBe(300)
    expect(open[0]).not.toHaveProperty('collapsedFrom')
  })

  it('changes nothing for a note, or a card already in that state', () => {
    const cards = [note('n', rect(0, 0)), message('m', 1, rect(300, 0))]
    expect(setCardCollapsed(cards, 'n', true)).toBe(cards)
    expect(setCardCollapsed(cards, 'm', false)).toBe(cards)
  })

  it('hides what is drawn over a collapsed card, however deep', () => {
    const host = { ...message('a', 1, rect(0, 0, 400, 400)), collapsedFrom: 400 }
    const cards = [
      host,
      inset('i', 'a', rect(10, 10, 100, 100)),
      inset('j', 'i', rect(20, 20, 50, 50), 8)
    ]
    expect([...hiddenInsetIds(cards)].sort()).toEqual(['i', 'j'])
  })

  it('survives a stored layout whose hosts form a loop', () => {
    const cards = [inset('i', 'j', rect(0, 0, 50, 50)), inset('j', 'i', rect(0, 0, 50, 50), 8)]
    expect([...hiddenInsetIds(cards)]).toEqual([])
  })

  it('does not fit the height of a collapsed card to an answer it cannot show', () => {
    const closed = setCardCollapsed([message('a', 1, rect(0, 0, 100, 300))], 'a', true)
    expect(fitCardHeight(closed, 'a', 900)).toEqual([])
  })
})

describe('arranging', () => {
  const two = [message('a', 1, rect(0, 0)), message('b', 3, rect(300, 50, 100, 200))]

  function landed(
    result: ReturnType<typeof alignSelection>,
    cards: CanvasCard[]
  ): Record<string, CanvasRect> {
    if (!result.ok) throw new Error('refused')
    return Object.fromEntries(
      cards.map((card) => [
        card.id,
        result.cards.find((update) => update.id === card.id)?.rect ?? card.rect
      ])
    )
  }

  it('aligns tops without touching anything else', () => {
    const at = landed(alignSelection({ cards: two, frames: [] }, new Set(['a', 'b']), 'top'), two)
    expect(at.a.y).toBe(0)
    expect(at.b.y).toBe(0)
    expect(at.b.x).toBe(300)
  })

  it('spaces out cards that aligning would pile on top of each other', () => {
    const at = landed(alignSelection({ cards: two, frames: [] }, new Set(['a', 'b']), 'left'), two)
    expect(at.a.x).toBe(0)
    expect(at.b.x).toBe(0)
    expect(rectsOverlap(at.a, at.b)).toBe(false)
  })

  it('refuses rather than land on a card outside the selection', () => {
    const cards = [...two, message('c', 5, rect(0, 300, 100, 100))]
    const result = alignSelection({ cards, frames: [] }, new Set(['a', 'b']), 'left')
    expect(result.ok).toBe(false)
  })

  it('moves joined cards together, so aligning cannot split a session', () => {
    const cards = [
      message('a', 1, rect(0, 0)),
      message('joined', 3, rect(100, 0), 'a'),
      message('b', 5, rect(500, 300))
    ]
    const at = landed(alignSelection({ cards, frames: [] }, new Set(['a', 'b']), 'bottom'), cards)
    expect(at.joined.x).toBe(at.a.x + at.a.w)
    expect(at.joined.y).toBe(at.a.y)
  })

  it('counts joined cards as one block', () => {
    const cards = [message('a', 1, rect(0, 0)), message('b', 3, rect(100, 0), 'a')]
    expect(selectionBlockCount({ cards, frames: [] }, new Set(['a', 'b']))).toBe(1)
    expect(alignSelection({ cards, frames: [] }, new Set(['a', 'b']), 'top').ok).toBe(false)
  })

  it('evens out gaps, keeping the outermost where they are', () => {
    const cards = [
      message('a', 1, rect(0, 0)),
      message('b', 3, rect(120, 0)),
      message('c', 5, rect(1000, 0))
    ]
    const at = landed(
      distributeSelection({ cards, frames: [] }, new Set(['a', 'b', 'c']), 'x'),
      cards
    )
    expect(at.a.x).toBe(0)
    expect(at.c.x).toBe(1000)
    expect(at.b.x).toBe(500)
  })

  it('needs three blocks to distribute', () => {
    expect(distributeSelection({ cards: two, frames: [] }, new Set(['a', 'b']), 'x').ok).toBe(false)
  })

  it('tidies into rows with no overlaps, keeping sessions and frames rigid', () => {
    const cards = [
      message('a', 1, rect(0, 0)),
      message('b', 3, rect(100, 0), 'a'),
      message('c', 5, rect(40, 900)),
      note('n', rect(2000, 2000)),
      message('inframe', 7, rect(5010, 5010))
    ]
    const frames = [frame('f', rect(5000, 5000, 300, 300))]
    const result = tidySelection({ cards, frames })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const at = Object.fromEntries(result.cards.map((update) => [update.id, update.rect]))
    const standing = Object.values(at)
    for (const [i, one] of standing.entries()) {
      for (const other of standing.slice(i + 1)) expect(rectsOverlap(one, other)).toBe(false)
    }
    expect(at.b.x - at.a.x).toBe(100)
    expect(at.b.y).toBe(at.a.y)
    const frameAt = result.frames[0].rect
    expect(at.inframe.x - frameAt.x).toBe(10)
    expect(at.inframe.y - frameAt.y).toBe(10)
  })

  it('tidies a selection clear of what is not selected', () => {
    const cards = [
      message('a', 1, rect(0, 0)),
      message('b', 3, rect(0, 500)),
      message('still', 5, rect(0, 120))
    ]
    const result = tidySelection({ cards, frames: [] }, new Set(['a', 'b']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const update of result.cards) {
      expect(rectsOverlap(update.rect, cards[2].rect)).toBe(false)
    }
    expect(result.cards.some((update) => update.id === 'still')).toBe(false)
  })
})

describe('duplicating', () => {
  const counter = (): (() => number) => {
    let next = 100
    return () => next++
  }
  const ids = (): {
    newId: () => string
    newTurnId: () => number
    streamingTurnIds: Set<number>
  } => {
    let next = 0
    return {
      newId: () => `copy${next++}`,
      newTurnId: counter(),
      streamingTurnIds: new Set<number>()
    }
  }

  it('copies a message as a branch of the same session, clear of everything', () => {
    const cards = [message('a', 1, rect(0, 0)), message('b', 3, rect(0, 100), 'a')]
    const copy = duplicateSelection(
      { cards, frames: [], links: [] },
      turnsFor(1, 3),
      new Set(['b']),
      ids()
    )
    const made = copy?.cards[0] as CanvasMessageCard
    expect(made.parentId).toBe('a')
    expect(made.userTurnId).not.toBe(3)
    expect(copy?.turns.map((turn) => turn.content)).toEqual(['question 3', 'answer 3'])
    for (const card of cards) expect(rectsOverlap(made.rect, card.rect)).toBe(false)
  })

  it('drops expansions, whose offsets belong to the original turn', () => {
    const turns = turnsFor(1).map((turn) =>
      turn.role === 'assistant' ? { ...turn, expansions: [expansionNode] } : turn
    )
    const cards = [message('a', 1, rect(0, 0, 400, 400)), inset('i', 'a', rect(10, 10, 80, 80))]
    const copy = duplicateSelection({ cards, frames: [], links: [] }, turns, new Set(['a']), ids())
    expect(copy?.cards.map((card) => card.kind)).toEqual(['message'])
    expect(copy?.turns.every((turn) => turn.expansions.length === 0)).toBe(true)
  })

  it('points copied parents and connections at the copies when both were chosen', () => {
    const cards = [message('a', 1, rect(0, 0)), message('b', 3, rect(0, 100), 'a')]
    const links = [{ id: 'l', from: 'a', to: 'b', label: 'leads to' }]
    const copy = duplicateSelection(
      { cards, frames: [], links },
      turnsFor(1, 3),
      new Set(['a', 'b']),
      ids()
    )
    const [first, second] = copy?.cards as CanvasMessageCard[]
    expect(second.parentId).toBe(first.id)
    expect(copy?.links[0]).toMatchObject({ from: first.id, to: second.id, label: 'leads to' })
  })

  it('takes what a chosen frame holds', () => {
    const cards = [note('n', rect(10, 10)), note('out', rect(900, 900))]
    const frames = [frame('f', rect(0, 0, 300, 300))]
    const copy = duplicateSelection({ cards, frames, links: [] }, [], new Set(['f']), ids())
    expect(copy?.frames).toHaveLength(1)
    expect(copy?.cards).toHaveLength(1)
    expect((copy?.cards[0] as CanvasNoteCard).text).toBe('a thought')
    const offset = (copy?.cards[0].rect.x as number) - (copy?.frames[0].rect.x as number)
    expect(offset).toBe(10)
  })

  it('leaves out an answer still being written', () => {
    const cards = [message('a', 1, rect(0, 0))]
    const copy = duplicateSelection({ cards, frames: [], links: [] }, turnsFor(1), new Set(['a']), {
      ...ids(),
      streamingTurnIds: new Set([2])
    })
    expect(copy).toBeNull()
  })
})

describe('undo and redo', () => {
  const moved = (card: CanvasCard, x: number): CanvasCard => ({
    ...card,
    rect: { ...card.rect, x }
  })

  it('reports no patch when nothing changed', () => {
    const state = snapshot([message('a', 1, rect(0, 0))], turnsFor(1))
    expect(diffCanvas('Nothing', state, { ...state })).toBeNull()
  })

  it('takes back a move and puts it back again', () => {
    const before = snapshot([message('a', 1, rect(0, 0))], turnsFor(1))
    const after = { ...before, cards: [moved(before.cards[0], 500)] }
    const patch = diffCanvas('Move', before, after)!
    const undone = applyCanvasPatch(after, patch, 'undo')
    expect(undone.ok && undone.snapshot.cards[0].rect.x).toBe(0)
    if (!undone.ok) return
    const redone = applyCanvasPatch(undone.snapshot, patch, 'redo')
    expect(redone.ok && redone.snapshot.cards[0].rect.x).toBe(500)
  })

  it('does not rewind an answer that kept streaming after the action', () => {
    const turns = turnsFor(1)
    const before = snapshot([message('a', 1, rect(0, 0))], turns)
    const after = { ...before, cards: [moved(before.cards[0], 500)] }
    const patch = diffCanvas('Move', before, after)!
    const streamed = {
      ...after,
      turns: turns.map((turn) =>
        turn.role === 'assistant' ? { ...turn, content: 'much more text' } : turn
      )
    }
    const undone = applyCanvasPatch(streamed, patch, 'undo')
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    expect(undone.snapshot.cards[0].rect.x).toBe(0)
    expect(undone.snapshot.turns[1].content).toBe('much more text')
  })

  it('keeps a card asked for after the action being undone', () => {
    const before = snapshot([message('a', 1, rect(0, 0))], turnsFor(1))
    const after = { ...before, cards: [moved(before.cards[0], 500)] }
    const patch = diffCanvas('Move', before, after)!
    const asked = {
      ...after,
      turns: [...after.turns, ...turnsFor(3)],
      cards: [...after.cards, message('new', 3, rect(1000, 0))]
    }
    const undone = applyCanvasPatch(asked, patch, 'undo')
    expect(undone.ok && undone.snapshot.cards.map((card) => card.id)).toEqual(['a', 'new'])
  })

  it('brings a deleted card back with its turns, where it was', () => {
    const turns = turnsFor(1, 3, 5)
    const cards = [
      message('a', 1, rect(0, 0)),
      message('b', 3, rect(200, 0)),
      message('c', 5, rect(400, 0))
    ]
    const before = snapshot(cards, turns, {
      links: [{ id: 'l', from: 'a', to: 'b' }]
    })
    const after = snapshot(
      [cards[0], cards[2]],
      turns.filter((turn) => turn.id !== 3 && turn.id !== 4)
    )
    const patch = diffCanvas('Delete', before, after)!
    const undone = applyCanvasPatch(after, patch, 'undo')
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    expect(undone.snapshot.cards.map((card) => card.id)).toEqual(['a', 'b', 'c'])
    expect(undone.snapshot.turns.map((turn) => turn.id)).toEqual([1, 2, 3, 4, 5, 6])
    expect(undone.snapshot.links).toEqual([{ id: 'l', from: 'a', to: 'b' }])
  })

  it('removes a created note on undo, and restores it on redo', () => {
    const before = snapshot([])
    const after = snapshot([note('n', rect(0, 0))])
    const patch = diffCanvas('Add note', before, after)!
    const undone = applyCanvasPatch(after, patch, 'undo')
    expect(undone.ok && undone.snapshot.cards).toEqual([])
    if (!undone.ok) return
    const redone = applyCanvasPatch(undone.snapshot, patch, 'redo')
    expect(redone.ok && redone.snapshot.cards.map((card) => card.id)).toEqual(['n'])
  })

  it('settles an expansion that was still streaming when its card was deleted', () => {
    const streaming: ExpansionNode = { ...expansionNode, status: 'loading' }
    const withExpansion = turnsFor(1).map((turn) =>
      turn.role === 'assistant' ? { ...turn, expansions: [streaming] } : turn
    )
    const cards = [message('a', 1, rect(0, 0)), inset('i', 'a', rect(5, 5, 50, 50))]
    const before = snapshot(cards, withExpansion)
    const after = snapshot(
      [cards[0]],
      withExpansion.map((turn) => ({ ...turn, expansions: [] }))
    )
    const patch = diffCanvas('Delete', before, after)!
    const undone = applyCanvasPatch(after, patch, 'undo')
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    expect(undone.snapshot.turns[1].expansions[0].status).not.toBe('loading')
    expect(undone.snapshot.cards.map((card) => card.id)).toEqual(['a', 'i'])
  })

  it('refuses when a turn it would restore has moved on', () => {
    const turns = turnsFor(1).map((turn) =>
      turn.role === 'assistant' ? { ...turn, expansions: [expansionNode] } : turn
    )
    const cards = [message('a', 1, rect(0, 0)), inset('i', 'a', rect(5, 5, 50, 50))]
    const before = snapshot(cards, turns)
    const afterTurns = turns.map((turn) => ({ ...turn, expansions: [] }))
    const after = snapshot([cards[0]], afterTurns)
    const patch = diffCanvas('Delete', before, after)!
    const regenerated = {
      ...after,
      turns: afterTurns.map((turn) =>
        turn.role === 'assistant' ? { ...turn, content: 'a fresh answer' } : turn
      )
    }
    expect(applyCanvasPatch(regenerated, patch, 'undo')).toEqual({ ok: false, reason: 'changed' })
  })

  it('refuses to put a card back on top of one that took its place', () => {
    const start = message('a', 1, rect(0, 0))
    const before = snapshot([start], turnsFor(1))
    const after = { ...before, cards: [moved(start, 500)] }
    const patch = diffCanvas('Move', before, after)!
    const occupied = {
      ...after,
      turns: [...after.turns, ...turnsFor(3)],
      cards: [...after.cards, message('new', 3, rect(0, 0))]
    }
    expect(applyCanvasPatch(occupied, patch, 'undo')).toEqual({ ok: false, reason: 'blocked' })
  })

  it('does not bring back a card that left some other way since', () => {
    const before = snapshot([message('a', 1, rect(0, 0))], turnsFor(1))
    const after = { ...before, cards: [moved(before.cards[0], 500)] }
    const patch = diffCanvas('Move', before, after)!
    const undone = applyCanvasPatch({ ...after, cards: [] }, patch, 'undo')
    expect(undone.ok && undone.snapshot.cards).toEqual([])
  })
})

describe('connections', () => {
  it('leave the side facing the other card and run to the side facing back', () => {
    const across = connectorGeometry(rect(0, 0), rect(500, 0))
    expect(across.d.startsWith('M 100 50')).toBe(true)
    expect(across.d.endsWith('500 50')).toBe(true)
    const down = connectorGeometry(rect(0, 0), rect(0, 500))
    expect(down.d.startsWith('M 50 100')).toBe(true)
    expect(down.d.endsWith('50 500')).toBe(true)
  })

  it('find the middle of the curve for a label', () => {
    expect(connectorGeometry(rect(0, 0), rect(500, 0)).mid).toEqual({ x: 300, y: 50 })
  })
})

describe('the load boundary', () => {
  const turns = turnsFor(1)

  it('reads a layout saved before frames and links existed', () => {
    const layout = normalizeCanvasLayout(
      { cards: [message('a', 1, rect(0, 0))], viewport: { x: 0, y: 0, zoom: 1 } },
      turns
    )
    expect(layout.frames).toEqual([])
    expect(layout.links).toEqual([])
    expect(layout.cards).toHaveLength(1)
  })

  it('keeps sound notes, frames and links, and drops what cannot be used', () => {
    const layout = normalizeCanvasLayout(
      {
        cards: [
          message('a', 1, rect(0, 0)),
          note('n', rect(300, 0)),
          { kind: 'note', id: 'textless', rect: rect(0, 500) }
        ],
        frames: [frame('f', rect(0, 0, 500, 500)), { id: 'sizeless', title: 'x' }, null],
        links: [
          { id: 'ok', from: 'a', to: 'n', label: 'see' },
          { id: 'gone', from: 'a', to: 'missing' },
          { id: 'self', from: 'a', to: 'a' },
          7
        ]
      },
      turns
    )
    expect(layout.cards.map((card) => card.id)).toEqual(['a', 'n'])
    expect(layout.frames.map((item) => item.id)).toEqual(['f'])
    expect(layout.links).toEqual([{ id: 'ok', from: 'a', to: 'n', label: 'see' }])
  })

  it('forgets a colour, height or source it cannot trust', () => {
    const layout = normalizeCanvasLayout(
      {
        cards: [
          {
            ...message('a', 1, rect(0, 0)),
            color: 'chartreuse',
            collapsedFrom: -4,
            sources: ['missing'],
            parentId: 'missing'
          }
        ]
      },
      turns
    )
    expect(layout.cards[0]).toEqual(message('a', 1, rect(0, 0)))
  })

  it('keeps a colour and a source it can', () => {
    const asked = { ...message('a', 1, rect(0, 0)), color: 'teal', sources: ['n', 'missing'] }
    const layout = normalizeCanvasLayout({ cards: [asked, note('n', rect(300, 0))] }, turns)
    expect(layout.cards[0]).toMatchObject({ color: 'teal', sources: ['n'] })
  })
})

describe('the outline', () => {
  const turns = turnsFor(1, 3)

  it('nests a session under its root and groups what a frame holds', () => {
    const cards = [
      message('root', 1, rect(10, 10)),
      message('next', 3, rect(10, 110), 'root'),
      note('loose', rect(900, 900), 'loose thought')
    ]
    const frames = [frame('f', rect(0, 0, 400, 400), 'Group one')]
    const rows = canvasOutline({ cards, frames }, turns)
    expect(rows.map((row) => [row.id, row.depth])).toEqual([
      ['f', 0],
      ['root', 1],
      ['next', 2],
      ['loose', 0]
    ])
    expect(rows[0].label).toBe('Group one')
    expect(rows[1].label).toBe('question 1')
  })

  it('searches answers too, and shows where it found the words', () => {
    const cards = [message('a', 1, rect(0, 0)), note('n', rect(300, 0), 'grocery list')]
    const rows = canvasOutline({ cards, frames: [] }, turns)
    const inAnswer = searchCanvasOutline(rows, 'ANSWER')
    expect(inAnswer.map((hit) => hit.id)).toEqual(['a'])
    expect(inAnswer[0].snippet).toContain('answer')
    const inNote = searchCanvasOutline(rows, 'grocery list')
    expect(inNote.map((hit) => hit.id)).toEqual(['n'])
    expect(inNote[0].snippet).toBeUndefined()
    expect(searchCanvasOutline(rows, '   ')).toEqual([])
  })
})

describe('copying as markdown', () => {
  it('puts the cards in reading order under their questions', () => {
    const cards = [
      message('low', 3, rect(0, 500)),
      message('high', 1, rect(0, 0)),
      note('n', rect(0, 900), 'mine')
    ]
    expect(selectionMarkdown(cards, turnsFor(1, 3), new Set(['low', 'high', 'n']))).toBe(
      '### question 1\n\nanswer 1\n\n### question 3\n\nanswer 3\n\nmine'
    )
  })
})
