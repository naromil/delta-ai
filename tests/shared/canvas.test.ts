import { describe, expect, it } from 'vitest'
import type {
  CanvasCard,
  CanvasExpansionCard,
  CanvasMessageCard,
  CanvasRect
} from '../../src/shared/canvas'
import {
  adjacentSlot,
  cardStackRanks,
  continueHandleBlocked,
  canvasContinuations,
  cascadeCardIds,
  clampRectInside,
  containsRect,
  continuationCandidates,
  continuationParent,
  estimateWords,
  fitCardHeight,
  fitViewport,
  fitsOnScreen,
  linkPath,
  longestLine,
  movingCardIds,
  nearestCardInDirection,
  normalizeCanvasLayout,
  rectAgainst,
  rectsOverlap,
  resizeCard,
  resizeCardKeepingClear,
  resizeFollowerIds,
  raisedStack,
  resolveMove,
  rectClearBelow,
  rectClearOf,
  rectFromCorner,
  rectFromPoints,
  rectsOverlap,
  revealRect,
  screenToWorld,
  sharesSide,
  snapEdges,
  snapMove,
  sourceCardId,
  turnsThroughCard,
  unionRect,
  visibleWorldRect,
  wheelZoomFactor,
  chaseViewport,
  gridSpacing,
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
  at: CanvasRect = rect(0, 0, 50, 50)
): CanvasExpansionCard {
  return { kind: 'expansion', id, rect: at, turnId, expansionId, hostId }
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
  it('places a default-sized rectangle with its top-left corner at the point', () => {
    expect(rectFromCorner({ x: 50, y: 80 }, { w: 200, h: 100 })).toEqual({
      x: 50,
      y: 80,
      w: 200,
      h: 100
    })
  })

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

  it('lands between what prose and prose with lists need in the real cards', () => {
    // Words that fit, measured in the card styles with a 6.235px average character width.
    const measured: Array<[number, number, number, number]> = [
      [320, 240, 52, 54],
      [360, 280, 73, 82],
      [480, 360, 113, 130],
      [600, 420, 177, 216],
      [720, 560, 281, 327],
      [1200, 500, 309, 440],
      [300, 700, 155, 173]
    ]
    for (const [w, h, withLists, prose] of measured) {
      const words = estimateWords(rect(0, 0, w, h), 10, 6.235)
      expect(words).toBeGreaterThanOrEqual(withLists - 5)
      expect(words).toBeLessThanOrEqual(prose + 5)
    }
  })

  it('fits fewer words in a wider font', () => {
    const area = rect(0, 0, 400, 300)
    expect(estimateWords(area, 0, 8)).toBeLessThan(estimateWords(area, 0, 6))
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
  const over = expansion('e', 7, 2, 'a', rect(10, 10, 40, 40))
  const free = expansion('f', 8, 2, 'a', rect(500, 500))
  const fromFree = message('c', 5, rect(600, 500), 'f')
  const cards: CanvasCard[] = [root, next, over, free, fromFree]

  it('continues the newest card sharing a side, whatever it lies over', () => {
    expect(continuationParent(rect(200, 0), cards)?.id).toBe('b')
    expect(continuationParent(rect(0, 100), [root, over])?.id).toBe('a')
    expect(continuationParent(rect(-40, 10, 50, 40), [over])?.id).toBe('e')
    expect(continuationParent(rect(900, 900), cards)).toBeUndefined()
  })

  it('moves the whole session, but not expansions that only lie over it', () => {
    expect(movingCardIds(cards, 'b')).toEqual(new Set(['a', 'b']))
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

describe("a card's + handle", () => {
  const at = (x: number, y: number): CanvasRect => ({ x, y, w: 400, h: 100 })

  it('shows when a neighbour leaves too little room for a continuation', () => {
    const root = message('a', 1, at(0, 0))
    const near = message('b', 2, at(420, 0))
    expect(adjacentSlot(root, 'right', [root, near])).toBeNull()
    expect(continueHandleBlocked(root, 'right', [root, near])).toBe(false)
  })

  it('hides where a card touching that side would sit under it', () => {
    const root = message('a', 1, at(0, 0))
    const below = message('b', 2, at(0, 100))
    expect(continueHandleBlocked(root, 'bottom', [root, below])).toBe(true)
    expect(continueHandleBlocked(root, 'right', [root, below])).toBe(false)
  })
})

describe('dropping a dragged card', () => {
  const host = message('a', 1, rect(0, 0, 400, 400))
  const neighbour = message('b', 3, rect(600, 0, 200, 200))
  const free = expansion('e', 7, 2, 'a', rect(10, 10, 100, 100))
  const cards: CanvasCard[] = [host, neighbour, free]
  const alone = new Set(['e'])

  it('lands where it was dropped: on its host, across an edge or on another card', () => {
    for (const dx of [50, 350, 650]) {
      expect(resolveMove(cards, alone, dx, 0)).toEqual([
        { id: 'e', rect: rect(10 + dx, 10, 100, 100) }
      ])
    }
  })

  it('moves a session as one, even onto another card', () => {
    const next = message('n', 5, rect(400, 0, 100, 100), 'a')
    const group = new Set(['a', 'n'])
    const session: CanvasCard[] = [host, next, neighbour]
    expect(resolveMove(session, group, 150, 0).map((update) => update.rect.x)).toEqual([150, 550])
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
    expansion('e', 8, 2, 'a'),
    expansion('n', 9, 2, 'e'),
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

  it('eases a zoom without moving what is under the pointer, then arrives exactly', () => {
    const anchor = { x: 300, y: 200 }
    const start = { x: 40, y: -30, zoom: 0.7 }
    const target = zoomAt(start, anchor, 1.4)
    const world = screenToWorld(start, anchor)

    let current = start
    let frames = 0
    while (current !== target && frames < 200) {
      const previous = current
      current = chaseViewport(current, target, 16)
      expect(current.zoom).toBeGreaterThan(previous.zoom)
      if (current !== target) {
        expect(screenToWorld(current, anchor).x).toBeCloseTo(world.x, 6)
        expect(screenToWorld(current, anchor).y).toBeCloseTo(world.y, 6)
      }
      frames++
    }
    expect(current).toBe(target)
    expect(frames).toBeGreaterThan(5)
    expect(frames).toBeLessThan(45)
    // One mouse notch no longer lands in a single frame.
    const notch = zoomAt(start, anchor, start.zoom * wheelZoomFactor(-120))
    expect(notch.zoom / start.zoom).toBeGreaterThan(1.2)
    expect(chaseViewport(start, notch, 16).zoom / start.zoom).toBeLessThan(1.1)
  })

  it('spreads one wheel pan over several frames', () => {
    const target = { x: 0, y: -120, zoom: 1 }
    const first = chaseViewport({ x: 0, y: 0, zoom: 1 }, target, 16)
    expect(first.y).toBeLessThan(0)
    expect(first.y).toBeGreaterThan(-40)
  })

  it('keeps grid dots apart when zoomed out, on the same origin', () => {
    expect(gridSpacing(1)).toBe(28)
    expect(gridSpacing(2)).toBe(56)
    expect(gridSpacing(0.25)).toBe(28)
    expect(gridSpacing(0.5)).toBe(28)
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
          expansion('e', 7, 2, 'a'),
          expansion('no-node', 99, 2, 'a'),
          expansion('no-host', 7, 2, 'gone'),
          expansion('chained', 7, 2, 'no-host'),
          { ...good, id: 'adrift', parentId: 'gone' }
        ]
      },
      turns
    )
    expect(layout.cards.map((card) => card.id)).toEqual(['a', 'e', 'adrift'])
    expect((layout.cards[2] as CanvasMessageCard).parentId).toBeUndefined()
  })

  it('checks containment', () => {
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
  const over = (id: string, hostId: string, at: CanvasRect): CanvasExpansionCard =>
    expansion(id, 1, 1, hostId, at)
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

  it('takes a side continuation with a pushed card, and pushes what it newly reaches', () => {
    const cards = [
      message('a', 1, rect(0, 0, 300, 200)),
      message('b', 3, rect(0, 200, 300, 200)),
      over('over-b', 'b', rect(20, 230, 100, 90)),
      message('beside-b', 5, rect(300, 200, 300, 200), 'b')
    ]
    const updates = fitCardHeight(cards, 'a', 260)
    expect(topOf(updates, 'b')).toBe(260)
    expect(topOf(updates, 'over-b')).toBe(260)
    expect(topOf(updates, 'beside-b')).toBe(260)
  })

  it('fits an expansion lying over its host, leaving the host where it is', () => {
    const cards = [message('a', 1, rect(0, 0, 300, 300)), over('e', 'a', rect(20, 100, 100, 90))]
    expect(fitCardHeight(cards, 'e', 900)).toEqual([{ id: 'e', rect: rect(20, 100, 100, 900) }])
  })

  it('shrinks a host under an expansion lying over it', () => {
    const cards = [message('a', 1, rect(0, 0, 300, 400)), over('e', 'a', rect(20, 200, 100, 100))]
    expect(heightOf(fitCardHeight(cards, 'a', 150), 'a')).toBe(150)
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

describe('stacking cards that overlap', () => {
  const a = message('a', 1, rect(0, 0, 200, 200))
  const b = message('b', 3, rect(100, 100, 200, 200))
  const far = message('far', 5, rect(900, 0, 200, 200))
  const cards = [a, b, far]

  it('puts newer cards on top until something is brought forward', () => {
    const ranks = cardStackRanks(cards, [])
    expect(ranks.get('b')).toBeGreaterThan(ranks.get('a') as number)
  })

  it('brings a covered card above what covers it, without reordering the cards', () => {
    const stack = raisedStack(cards, [], ['a'])
    const ranks = cardStackRanks(cards, stack)
    expect(ranks.get('a')).toBeGreaterThan(ranks.get('b') as number)
    expect(cards.map((card) => card.id)).toEqual(['a', 'b', 'far'])
  })

  it('changes nothing when nothing covers the card', () => {
    const stack = ['a']
    expect(raisedStack(cards, stack, ['b'])).toBe(stack)
    expect(raisedStack(cards, stack, ['far'])).toBe(stack)
    expect(raisedStack(cards, stack, ['missing'])).toBe(stack)
  })

  it('puts a new card above everything brought forward', () => {
    const stack = raisedStack(cards, [], ['a'])
    const fresh = message('new', 7, rect(50, 50, 100, 100))
    const ranks = cardStackRanks([...cards, fresh], stack)
    expect(ranks.get('new')).toBeGreaterThan(ranks.get('a') as number)
  })

  it('brings an expansion forward without its host', () => {
    const over = expansion('e', 7, 2, 'a', rect(10, 10, 50, 50))
    const all = [over, a]
    const raised = cardStackRanks(all, raisedStack(all, [], ['e']))
    expect(raised.get('e')).toBeGreaterThan(raised.get('a') as number)
  })

  it('trusts no stored stack', () => {
    const note = { kind: 'note', id: 'a', rect: rect(0, 0), text: 'x' }
    const layout = normalizeCanvasLayout({ cards: [note], stack: ['a', 'a', 'gone', 3] }, [])
    expect(layout.stack).toEqual(['a'])
    expect(normalizeCanvasLayout({}, []).stack).toEqual([])
  })
})

describe('keeping adjacent cards joined', () => {
  const movedTo = (updates: ReturnType<typeof resizeCard>, id: string): CanvasRect | undefined =>
    updates?.find((update) => update.id === id)?.rect

  it('drags touching cards as one, whatever session they are in', () => {
    const cards = [
      message('a', 1, rect(0, 0)),
      message('b', 3, rect(100, 0)),
      message('c', 5, rect(100, 100)),
      message('apart', 7, rect(400, 0))
    ]
    expect(movingCardIds(cards, 'a')).toEqual(new Set(['a', 'b', 'c']))
    expect(movingCardIds(cards, 'apart')).toEqual(new Set(['apart']))
  })

  it('leaves a continuation behind once it no longer touches, keeping its history', () => {
    const turns: Turn[] = [
      turn(1, 'user', 'first'),
      turn(2, 'assistant', 'one'),
      turn(3, 'user', 'second'),
      turn(4, 'assistant', 'two')
    ]
    const cards = [message('a', 1, rect(0, 0)), message('b', 3, rect(500, 0), 'a')]
    expect(movingCardIds(cards, 'a')).toEqual(new Set(['a']))
    expect(movingCardIds(cards, 'b')).toEqual(new Set(['b']))
    expect(turnsThroughCard(cards, turns, 'b')).toHaveLength(4)
  })

  it('does not count a corner as touching', () => {
    const cards = [message('a', 1, rect(0, 0)), message('corner', 3, rect(100, 100))]
    expect(movingCardIds(cards, 'a')).toEqual(new Set(['a']))
  })

  it('keeps the neighbour on the new boundary when widening and narrowing', () => {
    const cards = [
      message('a', 1, rect(0, 0, 300, 200)),
      message('b', 3, rect(300, 0, 300, 200)),
      message('c', 5, rect(600, 0, 300, 200))
    ]
    const wider = resizeCard(cards, 'a', { w: 350, h: 200 })
    expect(movedTo(wider, 'a')).toEqual(rect(0, 0, 350, 200))
    expect(movedTo(wider, 'b')).toEqual(rect(350, 0, 300, 200))
    expect(movedTo(wider, 'c')).toEqual(rect(650, 0, 300, 200))
    const narrower = resizeCard(cards, 'a', { w: 250, h: 200 })
    expect(movedTo(narrower, 'b')).toEqual(rect(250, 0, 300, 200))
    expect(movedTo(narrower, 'c')).toEqual(rect(550, 0, 300, 200))
  })

  it('keeps the card below on the new boundary, and leaves the one alongside', () => {
    const cards = [
      message('a', 1, rect(0, 0, 300, 200)),
      message('below', 3, rect(0, 200, 300, 200)),
      message('right', 5, rect(300, 0, 300, 200))
    ]
    const taller = resizeCard(cards, 'a', { w: 300, h: 260 })
    expect(movedTo(taller, 'below')).toEqual(rect(0, 260, 300, 200))
    expect(movedTo(taller, 'right')).toBeUndefined()
  })

  it('moves both ways when both sides change', () => {
    const cards = [
      message('a', 1, rect(0, 0, 300, 200)),
      message('below', 3, rect(0, 200, 300, 200)),
      message('right', 5, rect(300, 0, 300, 200))
    ]
    const both = resizeCard(cards, 'a', { w: 340, h: 170 })
    expect(movedTo(both, 'below')?.y).toBe(170)
    expect(movedTo(both, 'right')?.x).toBe(340)
  })

  it('takes what hangs only off a follower, but not what merely lies over one', () => {
    const over = expansion('over', 9, 2, 'b', rect(320, 20, 50, 50))
    const cards = [
      message('a', 1, rect(0, 0, 300, 200)),
      message('b', 3, rect(300, 0, 300, 200)),
      message('under-b', 5, rect(300, 200, 300, 200)),
      over
    ]
    const wider = resizeCard(cards, 'a', { w: 340, h: 200 })
    expect(movedTo(wider, 'b')?.x).toBe(340)
    expect(movedTo(wider, 'under-b')?.x).toBe(340)
    expect(movedTo(wider, 'over')).toBeUndefined()
  })

  it('leaves a card also joined by another route, which stays adjacent', () => {
    const cards = [
      message('a', 1, rect(0, 0, 300, 200)),
      message('b', 3, rect(300, 0, 300, 200)),
      message('d', 5, rect(0, 200, 300, 200)),
      message('e', 7, rect(300, 200, 300, 200))
    ]
    const wider = resizeCard(cards, 'a', { w: 340, h: 200 })
    expect(movedTo(wider, 'b')?.x).toBe(340)
    expect(movedTo(wider, 'd')).toBeUndefined()
    expect(movedTo(wider, 'e')).toBeUndefined()
  })

  it('lets a resize run over a card it was not joined to', () => {
    const cards = [
      message('a', 1, rect(0, 0, 300, 200)),
      message('near', 3, rect(320, 0, 100, 200))
    ]
    const wider = resizeCard(cards, 'a', { w: 400, h: 200 })
    expect(movedTo(wider, 'a')?.w).toBe(400)
    expect(movedTo(wider, 'near')).toBeUndefined()
  })

  it('pushes a card it reaches when that card is joined to it another way', () => {
    const cards = [
      message('a', 1, rect(0, 0, 100, 100)),
      message('under', 3, rect(0, 100, 400, 100)),
      message('on-under', 5, rect(200, 0, 100, 100))
    ]
    const wider = resizeCard(cards, 'a', { w: 250, h: 100 })
    expect(movedTo(wider, 'a')?.w).toBe(250)
    expect(movedTo(wider, 'on-under')?.x).toBe(250)
    expect(movedTo(wider, 'under')).toBeUndefined()
  })

  it('stops shrinking where joined cards would land on each other', () => {
    const cards = [
      message('a', 1, rect(0, 0, 300, 100)),
      message('tall', 3, rect(300, 0, 300, 300)),
      message('blocker', 5, rect(0, 100, 300, 100))
    ]
    expect(movedTo(resizeCard(cards, 'a', { w: 250, h: 100 }), 'a')?.w).toBe(300)
  })

  it('lets followers come back over a card not joined to them', () => {
    const cards = [
      message('a', 1, rect(0, 0, 300, 100)),
      message('tall', 3, rect(300, 0, 300, 300)),
      message('apart', 5, rect(0, 150, 280, 100))
    ]
    const narrower = resizeCard(cards, 'a', { w: 250, h: 100 })
    expect(movedTo(narrower, 'a')?.w).toBe(250)
    expect(movedTo(narrower, 'tall')?.x).toBe(250)
    expect(movedTo(narrower, 'apart')).toBeUndefined()
  })

  it('pushes a card that was not touching, in a chain, when keeping clear', () => {
    const cards = [
      message('a', 1, rect(0, 0, 300, 200)),
      message('near', 3, rect(320, 0, 100, 200)),
      message('next', 5, rect(420, 0, 100, 200)),
      message('far', 7, rect(320, 500, 100, 100))
    ]
    const wider = resizeCardKeepingClear(cards, 'a', { w: 400, h: 200 })
    expect(movedTo(wider, 'near')?.x).toBe(400)
    expect(movedTo(wider, 'next')?.x).toBe(500)
    expect(movedTo(wider, 'far')).toBeUndefined()
  })

  it('leaves a card it already overlapped where it is, when keeping clear', () => {
    const cards = [
      message('a', 1, rect(0, 0, 300, 200)),
      message('over', 3, rect(100, 100, 300, 300)),
      message('below', 5, rect(0, 450, 300, 100))
    ]
    const taller = resizeCardKeepingClear(cards, 'a', { w: 300, h: 500 })
    expect(movedTo(taller, 'over')).toBeUndefined()
    expect(movedTo(taller, 'below')?.y).toBe(500)
  })

  it('stops shrinking where a follower can come back no further, when keeping clear', () => {
    const cards = [
      message('a', 1, rect(0, 0, 300, 100)),
      message('tall', 3, rect(300, 0, 300, 300)),
      message('blocker', 5, rect(0, 100, 300, 100))
    ]
    const narrower = resizeCardKeepingClear(cards, 'a', { w: 250, h: 100 })
    expect(movedTo(narrower, 'a')?.w).toBe(300)
    expect(movedTo(narrower, 'tall')).toBeUndefined()
  })

  it('shrinks an L-shaped corner as far as it can, without overlap or a gap', () => {
    const cards = [
      message('a', 1, rect(0, 0, 440, 340)),
      message('right', 3, rect(440, 0, 380, 300)),
      message('below', 5, rect(0, 340, 380, 300))
    ]
    const updates = resizeCardKeepingClear(cards, 'a', { w: 320, h: 250 })
    const a = movedTo(updates, 'a') as CanvasRect
    const right = movedTo(updates, 'right') as CanvasRect
    const below = movedTo(updates, 'below') as CanvasRect
    expect(a).toEqual(rect(0, 0, 320, 300))
    expect(right.x).toBe(320)
    expect(below.y).toBe(300)
    expect(rectsOverlap(right, below)).toBe(false)
  })

  it('names the followers, so a resize does not snap to them', () => {
    const cards = [
      message('a', 1, rect(0, 0)),
      message('b', 3, rect(100, 0)),
      message('c', 5, rect(0, 100)),
      message('apart', 7, rect(500, 0))
    ]
    expect(resizeFollowerIds(cards, 'a')).toEqual(new Set(['b', 'c']))
  })

  it('follows on fitting too, for a card from another session', () => {
    const cards = [
      message('a', 1, rect(0, 0, 300, 300)),
      message('unrelated', 3, rect(0, 300, 300, 100))
    ]
    expect(fitCardHeight(cards, 'a', 200).find((update) => update.id === 'unrelated')?.rect.y).toBe(
      200
    )
  })
})

describe('touching several sessions', () => {
  // Two unrelated sessions, and a rectangle drawn in the gap between them.
  const older = message('old', 1, rect(0, 100))
  const newer = message('new', 3, rect(200, 100))
  const between = rect(100, 100)

  it('continues only the newest, and offers the others in that order', () => {
    expect(continuationCandidates(between, [older, newer]).map((card) => card.id)).toEqual([
      'new',
      'old'
    ])
    expect(continuationParent(between, [older, newer])?.id).toBe('new')
  })

  it('sends only the chosen session', () => {
    const turns: Turn[] = [
      turn(1, 'user', 'about cats'),
      turn(2, 'assistant', 'cats'),
      turn(3, 'user', 'about tax'),
      turn(4, 'assistant', 'tax'),
      turn(5, 'user', 'next'),
      turn(6, 'assistant', '')
    ]
    const asked = message('asked', 5, between, 'new')
    const sent = turnsThroughCard([older, newer, asked], turns, 'asked').map((t) => t.content)
    expect(sent).toEqual(['about tax', 'tax', 'next', ''])
  })
})

describe('navigation', () => {
  const a = message('a', 1, rect(0, 0))
  const b = message('b', 3, rect(0, 100), 'a')
  const c = message('c', 5, rect(100, 0), 'a')
  const far = message('far', 7, rect(400, 600))
  const e = expansion('e', 9, 2, 'b', rect(300, 120))
  const cards: CanvasCard[] = [a, b, c, far, e]

  it('goes to the nearest card in a direction, preferring a straight line', () => {
    expect(nearestCardInDirection(cards, 'a', 'bottom')?.id).toBe('b')
    expect(nearestCardInDirection(cards, 'a', 'right')?.id).toBe('c')
    expect(nearestCardInDirection(cards, 'b', 'top')?.id).toBe('a')
    expect(nearestCardInDirection(cards, 'a', 'left')).toBeUndefined()
    expect(nearestCardInDirection(cards, 'missing', 'left')).toBeUndefined()
  })

  it('goes back to the term an expansion explains, or the card a message continues', () => {
    expect(sourceCardId(e)).toBe('b')
    expect(sourceCardId(b)).toBe('a')
    expect(sourceCardId(a)).toBeUndefined()
  })

  it('places a rectangle of any size against a side', () => {
    expect(rectAgainst(rect(0, 0), 'bottom', { w: 50, h: 30 })).toEqual(rect(0, 100, 50, 30))
    expect(rectAgainst(rect(0, 0), 'left', { w: 50, h: 30 })).toEqual(rect(-50, 0, 50, 30))
    expect(sharesSide(rectAgainst(rect(0, 0), 'top', { w: 80, h: 30 }), rect(0, 0))).toBe(true)
  })

  it('keeps a gap from everything when opening a new session', () => {
    const placed = rectClearOf(rect(0, 0), [rect(0, 0)], 48)
    expect(placed.y).toBe(148)
    expect(sharesSide(placed, rect(0, 0))).toBe(false)
  })

  it('knows what is on screen and what fits there', () => {
    const size = { width: 1000, height: 800 }
    expect(visibleWorldRect({ x: -100, y: 0, zoom: 2 }, size)).toEqual(rect(50, 0, 500, 400))
    expect(unionRect(rect(0, 0), rect(100, 300))).toEqual(rect(0, 0, 200, 400))
    expect(fitsOnScreen(rect(0, 0, 800, 600), 1, size)).toBe(true)
    expect(fitsOnScreen(rect(0, 0, 800, 700), 1, size)).toBe(false)
    expect(fitsOnScreen(rect(0, 0, 800, 700), 0.5, size)).toBe(true)
  })
})

describe('canvasContinuations', () => {
  it('marks an expansion touching its host as a branch, and leaves a distant one its term link', () => {
    const host = message('a', 1, rect(0, 0))
    const expansion = (id: string, at: CanvasRect): CanvasCard => ({
      id,
      kind: 'expansion',
      hostId: 'a',
      turnId: 1,
      expansionId: 1,
      rect: at
    })
    const marks = canvasContinuations([
      host,
      expansion('touching', { ...rect(0, 0), x: host.rect.x + host.rect.w }),
      expansion('far', { ...rect(0, 0), x: 5000 }),
      expansion('over', { ...host.rect, x: 10, y: 10, w: 20, h: 20 }, true)
    ])
    expect(marks.map((mark) => [mark.id, mark.kind, mark.side])).toEqual([
      ['touching', 'seam', 'right']
    ])
  })

  it('marks the boundary when a card touches the one it continues', () => {
    const [mark] = canvasContinuations([
      message('a', 1, rect(0, 0)),
      message('b', 3, rect(0, 100), 'a')
    ])
    expect(mark).toEqual({
      kind: 'seam',
      id: 'b',
      side: 'bottom',
      start: { x: 6, y: 100 },
      end: { x: 94, y: 100 }
    })
  })

  it('runs the seam along only the part the two cards share', () => {
    const [mark] = canvasContinuations([
      message('a', 1, rect(0, 0)),
      message('b', 3, rect(100, 40), 'a')
    ])
    expect(mark).toMatchObject({
      kind: 'seam',
      side: 'right',
      start: { x: 100, y: 46 },
      end: { x: 100, y: 94 }
    })
  })

  it('points the way the session travels, whichever side the next card is on', () => {
    const sideOf = (at: CanvasRect): unknown =>
      canvasContinuations([message('a', 1, rect(0, 0)), message('b', 3, at, 'a')])[0]
    expect(sideOf(rect(-100, 0))).toMatchObject({ kind: 'seam', side: 'left' })
    expect(sideOf(rect(0, -100))).toMatchObject({ kind: 'seam', side: 'top' })
    expect(sideOf(rect(-400, 0))).toMatchObject({ kind: 'link', side: 'left' })
    expect(sideOf(rect(0, -400))).toMatchObject({ kind: 'link', side: 'top' })
  })

  it('links facing sides when a card stands apart from the one it continues', () => {
    const [mark] = canvasContinuations([
      message('a', 1, rect(0, 0)),
      message('b', 3, rect(400, 50), 'a')
    ])
    expect(mark).toMatchObject({
      kind: 'link',
      id: 'b',
      side: 'right',
      start: { x: 100, y: 50 },
      end: { x: 400, y: 100 }
    })
  })

  it('links a card joined to its parent only through another card', () => {
    const marks = canvasContinuations([
      message('a', 1, rect(0, 0)),
      message('between', 5, rect(0, 100)),
      message('b', 3, rect(0, 200), 'a')
    ])
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ kind: 'link', id: 'b', side: 'bottom' })
  })

  it('leaves two touching cards of different sessions unmarked', () => {
    expect(
      canvasContinuations([message('a', 1, rect(0, 0)), message('b', 3, rect(100, 0))])
    ).toEqual([])
  })

  it('counts a touching expansion and its continuation as one mark each', () => {
    const marks = canvasContinuations([
      message('a', 1, rect(0, 0)),
      expansion('e', 1, 2, 'a', rect(0, 100)),
      message('b', 3, rect(100, 100), 'e')
    ])
    expect(marks.map((mark) => [mark.kind, mark.id])).toEqual([
      ['seam', 'e'],
      ['seam', 'b']
    ])
  })

  it('marks the boundary with an expansion lying over its own host', () => {
    const marks = canvasContinuations([
      message('a', 1, rect(0, 0)),
      expansion('e', 1, 2, 'a', rect(10, 10, 90, 90)),
      message('b', 3, rect(100, 0), 'e')
    ])
    expect(marks.find((mark) => mark.id === 'b')).toMatchObject({ kind: 'seam' })
  })

  it('ignores a parent that no longer exists', () => {
    expect(canvasContinuations([message('b', 3, rect(0, 0), 'gone')])).toEqual([])
  })
})

describe('longestLine', () => {
  it('picks the widest line, so a wrapped term anchors on text', () => {
    const first = { width: 60, height: 17 }
    const second = { width: 150, height: 17 }
    expect(longestLine([first, second])).toBe(second)
  })

  it('keeps the earliest on a tie and ignores empty boxes', () => {
    const first = { width: 90, height: 17 }
    expect(longestLine([{ width: 0, height: 17 }, first, { width: 90, height: 17 }])).toBe(first)
    expect(longestLine([{ width: 40, height: 0 }])).toBeUndefined()
  })
})
