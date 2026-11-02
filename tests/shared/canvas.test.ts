import { describe, expect, it } from 'vitest'
import type {
  CanvasCard,
  CanvasExpansionCard,
  CanvasMessageCard,
  CanvasRect
} from '../../src/shared/canvas'
import {
  adjacentSlot,
  cascadeCardIds,
  clampRectInside,
  containsRect,
  continuationParent,
  estimateWords,
  fitCardHeight,
  fitViewport,
  linkPath,
  movingCardIds,
  normalizeCanvasLayout,
  resolveMove,
  rectClearBelow,
  rectFromPoints,
  rectsOverlap,
  revealRect,
  screenToWorld,
  sharesSide,
  snapEdges,
  snapMove,
  turnsThroughCard,
  wheelZoomFactor,
  withCanvasFit,
  zoomAt
} from '../../src/shared/canvas'
import type { Turn } from '../../src/shared/conversation'
import { serializeForChat } from '../../src/shared/conversation'
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

function expansion(
  id: string,
  expansionId: number,
  turnId: number,
  hostId: string,
  inset: boolean,
  at: CanvasRect = rect(0, 0, 50, 50)
): CanvasExpansionCard {
  return { kind: 'expansion', id, rect: at, turnId, expansionId, hostId, inset }
}

function turn(
  id: number,
  role: Turn['role'],
  content: string,
  expansions: ExpansionNode[] = []
): Turn {
  return { id, role, content, expansions }
}

function node(
  id: number,
  originalText: string,
  answer: string,
  children: ExpansionNode[] = []
): ExpansionNode {
  return {
    id,
    start: 0,
    end: originalText.length,
    originalText,
    answer,
    status: 'done',
    folded: false,
    children
  }
}

describe('rectangles', () => {
  it('builds a positive rectangle whichever way it was dragged', () => {
    expect(rectFromPoints({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({
      x: 10,
      y: 20,
      w: 40,
      h: 60
    })
  })

  it('does not count a shared side as overlap', () => {
    expect(rectsOverlap(rect(0, 0), rect(100, 0))).toBe(false)
    expect(rectsOverlap(rect(0, 0), rect(99.5, 0))).toBe(false)
    expect(rectsOverlap(rect(0, 0), rect(90, 0))).toBe(true)
  })

  it('needs real contact along a side to share it', () => {
    expect(sharesSide(rect(0, 0), rect(100, 50))).toBe(true)
    expect(sharesSide(rect(0, 0), rect(50, 100))).toBe(true)
    expect(sharesSide(rect(0, 0), rect(100, 90))).toBe(false)
    expect(sharesSide(rect(0, 0), rect(110, 0))).toBe(false)
    expect(sharesSide(rect(0, 0), rect(100, 100))).toBe(false)
  })

  it('clamps inside bounds and shrinks only what cannot fit', () => {
    expect(clampRectInside(rect(90, 90, 50, 50), rect(0, 0))).toEqual(rect(50, 50, 50, 50))
    expect(clampRectInside(rect(-10, 0, 300, 50), rect(0, 0))).toEqual(rect(0, 0, 100, 50))
  })
})

describe('snapping', () => {
  it('pulls a drawn edge onto a nearby card so the sides are shared exactly', () => {
    const { rect: snapped, guidesX } = snapEdges(rect(106, 0, 100, 100), [rect(0, 0)], 8)
    expect(snapped.x).toBe(100)
    expect(snapped.x + snapped.w).toBe(206)
    expect(guidesX).toContain(100)
    expect(sharesSide(snapped, rect(0, 0))).toBe(true)
  })

  it('leaves an edge alone beyond the threshold', () => {
    expect(snapEdges(rect(120, 300), [rect(0, 0)], 8).rect).toEqual(rect(120, 300))
  })

  it('keeps the size while sliding a moved rectangle', () => {
    const { rect: snapped } = snapMove(rect(-105, 0), [rect(0, 0)], 8)
    expect(snapped).toEqual(rect(-100, 0))
  })
})

describe('words that fit', () => {
  it('grows with the area', () => {
    expect(estimateWords(rect(0, 0, 600, 500))).toBeGreaterThan(estimateWords(rect(0, 0, 300, 250)))
  })

  it('leaves less room under a long caption', () => {
    const area = rect(0, 0, 400, 300)
    expect(estimateWords(area, 500)).toBeLessThan(estimateWords(area, 10))
  })

  it('stays in a believable range and never reaches zero', () => {
    const words = estimateWords(rect(0, 0, 400, 280))
    expect(words).toBeGreaterThan(40)
    expect(words).toBeLessThan(120)
    expect(estimateWords(rect(0, 0, 40, 40))).toBeGreaterThan(0)
  })

  it('states the length on the newest user message only', () => {
    const fitted = withCanvasFit(
      [
        { role: 'system', content: 's' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'second' }
      ],
      75
    )
    expect(fitted[1].content).toBe('first')
    expect(fitted[3].content).toContain('second')
    expect(fitted[3].content).toContain('about 75 words')
  })
})

describe('sessions', () => {
  const root = message('a', 1, rect(0, 0))
  const next = message('b', 3, rect(100, 0), 'a')
  const inset = expansion('e', 7, 2, 'a', true, rect(10, 10, 40, 40))
  const free = expansion('f', 8, 2, 'a', false, rect(500, 500))
  const fromFree = message('c', 5, rect(600, 500), 'f')
  const cards: CanvasCard[] = [root, next, inset, free, fromFree]

  it('continues the newest card sharing a side, and never an inset one', () => {
    expect(continuationParent(rect(200, 0), cards)?.id).toBe('b')
    expect(continuationParent(rect(0, 100), [root, inset])?.id).toBe('a')
    expect(continuationParent(rect(-40, 10, 50, 40), [inset])).toBeUndefined()
    expect(continuationParent(rect(900, 900), cards)).toBeUndefined()
  })

  it('moves the whole session and what sits on it, but not outward expansions', () => {
    expect(movingCardIds(cards, 'b')).toEqual(new Set(['a', 'b', 'e']))
  })

  it('moves an inset expansion alone', () => {
    expect(movingCardIds(cards, 'e')).toEqual(new Set(['e']))
  })

  it('keeps a session started from an outward expansion together', () => {
    expect(movingCardIds(cards, 'c')).toEqual(new Set(['c', 'f']))
  })

  it('deletes everything that depends on a card', () => {
    expect(cascadeCardIds(cards, 'a')).toEqual(new Set(['a', 'b', 'e', 'f', 'c']))
    expect(cascadeCardIds(cards, 'b')).toEqual(new Set(['b']))
    expect(cascadeCardIds(cards, 'f')).toEqual(new Set(['f', 'c']))
  })

  it('finds a free spot against a side, or none', () => {
    expect(adjacentSlot(root, 'bottom', cards)).toEqual(rect(0, 100))
    expect(adjacentSlot(root, 'right', cards)).toBeNull()
  })
})

describe('dropping a dragged card', () => {
  const host = message('a', 1, rect(0, 0, 400, 400))
  const neighbour = message('b', 3, rect(600, 0, 200, 200))
  const inset = expansion('e', 7, 2, 'a', true, rect(10, 10, 100, 100))
  const cards: CanvasCard[] = [host, neighbour, inset]
  const alone = new Set(['e'])

  it('stays inset while the expansion fits inside its host', () => {
    expect(resolveMove(cards, 'e', alone, 50, 50)).toEqual({
      ok: true,
      updates: [{ id: 'e', rect: rect(60, 60, 100, 100), inset: true }]
    })
  })

  it('becomes a separate card once it clears the host', () => {
    expect(resolveMove(cards, 'e', alone, 400, 0)).toEqual({
      ok: true,
      updates: [{ id: 'e', rect: rect(410, 10, 100, 100), inset: false }]
    })
  })

  it('refuses a drop across the edge of the host or onto another card', () => {
    expect(resolveMove(cards, 'e', alone, 350, 0).ok).toBe(false)
    expect(resolveMove(cards, 'e', alone, 650, 0).ok).toBe(false)
  })

  it('goes back inset when dragged home', () => {
    const free = expansion('f', 8, 2, 'a', false, rect(450, 0, 100, 100))
    const result = resolveMove([host, free], 'f', new Set(['f']), -300, 50)
    expect(result).toEqual({
      ok: true,
      updates: [{ id: 'f', rect: rect(150, 50, 100, 100), inset: true }]
    })
  })

  it('moves a session as one and checks every card in it', () => {
    const next = message('n', 5, rect(400, 0, 100, 100), 'a')
    const group = new Set(['a', 'n'])
    const session: CanvasCard[] = [host, next, neighbour]
    expect(resolveMove(session, 'a', group, 0, 500).ok).toBe(true)
    expect(resolveMove(session, 'a', group, 150, 0).ok).toBe(false)
  })
})

describe('session history', () => {
  const nested = node(9, 'inner', 'inner answer')
  const outer = node(8, 'term', 'term answer', [nested])
  const turns = [
    turn(1, 'user', 'q1'),
    turn(2, 'assistant', 'a1', [outer]),
    turn(3, 'user', 'q2'),
    turn(4, 'assistant', 'a2'),
    turn(5, 'user', 'branch'),
    turn(6, 'assistant', 'branch answer'),
    turn(10, 'user', 'about term'),
    turn(11, 'assistant', 'more')
  ]
  const cards: CanvasCard[] = [
    message('a', 1, rect(0, 0)),
    message('b', 3, rect(100, 0), 'a'),
    message('c', 5, rect(0, 100), 'a'),
    expansion('e', 8, 2, 'a', false),
    expansion('n', 9, 2, 'e', false),
    message('d', 10, rect(500, 0), 'n')
  ]

  it('follows the parent chain, so branches do not see each other', () => {
    expect(turnsThroughCard(cards, turns, 'c').map((t) => t.content)).toEqual([
      'q1',
      'a1',
      'branch',
      'branch answer'
    ])
  })

  it('walks through expansions when a session continues from one', () => {
    const messages = serializeForChat({ turns: turnsThroughCard(cards, turns, 'd') }, 'chat')
    expect(messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant'
    ])
    expect(messages[3].content).toContain('term')
    expect(messages[4].content).toBe('term answer')
    expect(messages[6].content).toBe('inner answer')
    expect(messages[7].content).toBe('about term')
  })
})

describe('links and viewport', () => {
  it('arrives at the side facing the term', () => {
    expect(linkPath({ x: 0, y: 50 }, rect(200, 0)).endsWith('200 50')).toBe(true)
    expect(linkPath({ x: 500, y: 50 }, rect(200, 0)).endsWith('300 50')).toBe(true)
    expect(linkPath({ x: 250, y: -300 }, rect(200, 0)).endsWith('250 0')).toBe(true)
  })

  it('follows a pinch and holds a mouse notch to one step', () => {
    const pinchTo = 1.05
    expect(wheelZoomFactor(-100 * Math.log(pinchTo))).toBeCloseTo(pinchTo)
    expect(wheelZoomFactor(120)).toBeCloseTo(wheelZoomFactor(1000))
    expect(wheelZoomFactor(-120)).toBeLessThan(1.3)
    expect(wheelZoomFactor(-120)).toBeGreaterThan(1.2)
  })

  it('zooms around the pointer and respects the limits', () => {
    const zoomed = zoomAt({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 100 }, 2)
    expect(screenToWorld(zoomed, { x: 100, y: 100 })).toEqual({ x: 100, y: 100 })
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, 99).zoom).toBe(2)
  })

  it('fits everything on screen without zooming in past 100%', () => {
    const size = { width: 1000, height: 800 }
    const small = fitViewport([rect(0, 0)], size)
    expect(small.zoom).toBe(1)
    expect(small.x).toBe(450)
    expect(fitViewport([rect(0, 0, 4000, 100)], size).zoom).toBeLessThan(1)
  })

  it('pans only when a rectangle is off screen', () => {
    const size = { width: 1000, height: 800 }
    const viewport = { x: 0, y: 0, zoom: 1 }
    expect(revealRect(viewport, rect(200, 200), size)).toEqual(viewport)
    const moved = revealRect(viewport, rect(2000, 200), size)
    expect(moved.x).toBe(1000 - 64 - 2100)
    expect(moved.y).toBe(0)
  })
})

describe('load boundary', () => {
  const turns = [turn(1, 'user', 'q'), turn(2, 'assistant', 'a', [node(7, 'term', 'x')])]

  it('survives garbage', () => {
    expect(normalizeCanvasLayout(undefined, turns).cards).toEqual([])
    expect(normalizeCanvasLayout({ cards: 'no', viewport: { x: 'a' } }, turns).viewport.zoom).toBe(
      1
    )
  })

  it('drops cards whose turn, expansion or host is gone, and detaches lost parents', () => {
    const good = message('a', 1, rect(0, 0))
    const layout = normalizeCanvasLayout(
      {
        cards: [
          good,
          message('lost', 50, rect(0, 0)),
          { ...good, id: 'bad-rect', rect: { x: 0, y: 0, w: -1, h: 5 } },
          expansion('e', 7, 2, 'a', true),
          expansion('no-node', 99, 2, 'a', true),
          expansion('no-host', 7, 2, 'gone', false),
          expansion('chained', 7, 2, 'no-host', false),
          { ...good, id: 'adrift', parentId: 'gone' }
        ]
      },
      turns
    )
    expect(layout.cards.map((card) => card.id)).toEqual(['a', 'e', 'adrift'])
    expect((layout.cards[2] as CanvasMessageCard).parentId).toBeUndefined()
  })

  it('checks containment for inset placement', () => {
    expect(containsRect(rect(0, 0), rect(10, 10, 50, 50))).toBe(true)
    expect(containsRect(rect(0, 0), rect(60, 60, 50, 50))).toBe(false)
  })
})

describe('rectClearBelow', () => {
  it('moves a rectangle below everything in its way, and leaves a clear one alone', () => {
    const others = [rect(0, 0, 100, 100), rect(0, 100, 100, 50)]
    expect(rectClearBelow(rect(0, 50, 100, 40), others)).toEqual(rect(0, 150, 100, 40))
    expect(rectClearBelow(rect(500, 50, 100, 40), others)).toEqual(rect(500, 50, 100, 40))
  })
})

describe('fitCardHeight', () => {
  const inset = (id: string, hostId: string, at: CanvasRect): CanvasExpansionCard => ({
    kind: 'expansion',
    id,
    rect: at,
    turnId: 1,
    expansionId: 1,
    hostId,
    inset: true
  })
  const heightOf = (updates: ReturnType<typeof fitCardHeight>, id: string): number | undefined =>
    updates.find((update) => update.id === id)?.rect.h
  const topOf = (updates: ReturnType<typeof fitCardHeight>, id: string): number | undefined =>
    updates.find((update) => update.id === id)?.rect.y

  it('changes only the height, and nothing when it already fits', () => {
    const cards = [message('a', 1, rect(10, 20, 300, 200))]
    expect(fitCardHeight(cards, 'a', 340)).toEqual([{ id: 'a', rect: rect(10, 20, 300, 340) }])
    expect(fitCardHeight(cards, 'a', 200)).toEqual([])
    expect(fitCardHeight(cards, 'missing', 200)).toEqual([])
  })

  it('never goes below the minimum, and rounds up so no text is cut', () => {
    const cards = [message('a', 1, rect(0, 0, 300, 300))]
    expect(heightOf(fitCardHeight(cards, 'a', 10), 'a')).toBe(120)
    expect(heightOf(fitCardHeight(cards, 'a', 340.2), 'a')).toBe(341)
  })

  it('brings a continuation below along, both ways, and leaves one alongside', () => {
    const cards = [
      message('a', 1, rect(0, 0, 300, 200)),
      message('below', 3, rect(0, 200, 300, 200), 'a'),
      message('right', 5, rect(300, 0, 300, 200), 'a')
    ]
    const grown = fitCardHeight(cards, 'a', 300)
    expect(topOf(grown, 'below')).toBe(300)
    expect(topOf(grown, 'right')).toBeUndefined()
    expect(topOf(fitCardHeight(cards, 'a', 150), 'below')).toBe(150)
  })

  it('pushes whatever is in the way, in a chain, so nothing overlaps', () => {
    const cards = [
      message('a', 1, rect(0, 0, 300, 200)),
      message('b', 3, rect(0, 250, 300, 100)),
      message('c', 5, rect(0, 350, 300, 100)),
      message('far', 7, rect(900, 250, 300, 100))
    ]
    const updates = fitCardHeight(cards, 'a', 300)
    expect(topOf(updates, 'b')).toBe(300)
    expect(topOf(updates, 'c')).toBe(400)
    expect(topOf(updates, 'far')).toBeUndefined()
  })

  it('takes what sits on a pushed card and a side continuation with it', () => {
    const cards = [
      message('a', 1, rect(0, 0, 300, 200)),
      message('b', 3, rect(0, 200, 300, 200)),
      inset('over-b', 'b', rect(20, 230, 100, 90)),
      message('beside-b', 5, rect(300, 200, 300, 200), 'b')
    ]
    const updates = fitCardHeight(cards, 'a', 260)
    expect(topOf(updates, 'b')).toBe(260)
    expect(topOf(updates, 'over-b')).toBe(290)
    expect(topOf(updates, 'beside-b')).toBe(260)
  })

  it('keeps an inset card inside its host', () => {
    const cards = [message('a', 1, rect(0, 0, 300, 300)), inset('e', 'a', rect(20, 100, 100, 90))]
    expect(fitCardHeight(cards, 'e', 900)).toEqual([{ id: 'e', rect: rect(20, 100, 100, 200) }])
  })

  it('never shrinks a host past what sits on its text', () => {
    const cards = [message('a', 1, rect(0, 0, 300, 400)), inset('e', 'a', rect(20, 200, 100, 100))]
    expect(heightOf(fitCardHeight(cards, 'a', 150), 'a')).toBe(300)
  })

  it('stays tall when what hangs below cannot follow it up', () => {
    const cards = [
      message('a', 1, rect(0, 100, 300, 200)),
      message('below', 3, rect(0, 300, 600, 200), 'a'),
      message('blocker', 5, rect(300, 100, 300, 200))
    ]
    expect(fitCardHeight(cards, 'a', 150)).toEqual([])
  })
})
