/**
 * Tidying the canvas, family by family. Cards attached to each other form a block, which stays
 * attached and is only straightened (`canvas-straighten.ts`). A family is the blocks that parent-child relationships connect: they are drawn
 * in layers along the way they already run, so their lines cross as little as possible. Families
 * are then packed apart, in the order that crosses the fewest of the lines left between them. A
 * drawn link never joins anything; it only affects that order. Everything is pure.
 */
import type { CanvasAxis, CanvasArrangeResult, CanvasBlock, PlacedBlock } from './canvas-arrange'
import { blocksFor, placedRect, settleBlocks } from './canvas-arrange'
import type { CanvasCard, CanvasLayout, CanvasPoint, CanvasRect } from './canvas'
import { askedAboutRelations, cardRects, rectClearOf, sharesSide } from './canvas'
import { boundsOf, movingBounds } from './canvas-selection'
import { straightenBlocks } from './canvas-straighten'
import type { LayoutEdge } from './layered-layout'
import { layeredLayout } from './layered-layout'

export type TidyItems = Pick<CanvasLayout, 'cards' | 'frames' | 'links'>

interface ParentEdge {
  parent: CanvasCard
  child: CanvasCard
}

interface TidyFamily {
  blocks: CanvasBlock[]
  edges: ParentEdge[]
}

/** A family, with `placed` relative to its own corner. */
interface TidyBox {
  placed: PlacedBlock[]
  w: number
  h: number
}

/** A pair of cards with a line drawn between them. */
type CardLine = readonly [string, string]

/** Space kept from what stays put. */
const CLEARANCE = 48
/** Between blocks in one layer of a family. */
const SIBLING_GAP = 48
/** Between the layers of a family. */
const LAYER_GAP = 72
/** Wider than anything inside a family, so families read as families. */
const FAMILY_GAP = 120
/** How strongly a line holds its two ends in line: a session reads straight through. */
const CONTINUATION_WEIGHT = 8
const EXPANSION_WEIGHT = 1
/** The shape a tidied canvas aims for, roughly a window's. */
const TIDY_ASPECT = 1.6
const ORDER_PASSES = 4
/** With more families than this, an order is only tried against its near neighbours. */
const FULL_SEARCH_FAMILIES = 12
const NEAR_SEARCH_REACH = 4
/** One crossing costs more than any length of line can save. */
const CROSSING_COST = 1e9
/** A line running behind a card it does not belong to, which is bad but less so than a crossing. */
const OVER_CARD_COST = 1e8

function shifted(rect: CanvasRect, by: CanvasPoint): CanvasRect {
  return { ...rect, x: rect.x + by.x, y: rect.y + by.y }
}

function centerOf(rect: CanvasRect): CanvasPoint {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
}

/* ---- Families ---- */

function parentEdges(items: TidyItems, blockOf: ReadonlyMap<string, CanvasBlock>): ParentEdge[] {
  const byId = new Map(items.cards.map((card) => [card.id, card]))
  return items.cards.flatMap((child): ParentEdge[] => {
    const parentId =
      child.kind === 'message' ? child.parentId : child.kind === 'expansion' ? child.hostId : null
    const parent = parentId ? byId.get(parentId) : undefined
    if (!parent || !blockOf.has(parent.id) || !blockOf.has(child.id)) return []
    if (blockOf.get(parent.id) === blockOf.get(child.id)) return []
    return [{ parent, child }]
  })
}

function familiesOf(
  blocks: CanvasBlock[],
  edges: ParentEdge[],
  blockOf: ReadonlyMap<string, CanvasBlock>
): TidyFamily[] {
  const leader = new Map(blocks.map((block) => [block, block]))
  const find = (block: CanvasBlock): CanvasBlock => {
    const next = leader.get(block) as CanvasBlock
    return next === block ? block : find(next)
  }
  for (const { parent, child } of edges) {
    leader.set(
      find(blockOf.get(parent.id) as CanvasBlock),
      find(blockOf.get(child.id) as CanvasBlock)
    )
  }
  const families = new Map<CanvasBlock, TidyFamily>()
  for (const block of blocks) {
    const key = find(block)
    const family = families.get(key) ?? { blocks: [], edges: [] }
    family.blocks.push(block)
    families.set(key, family)
  }
  for (const edge of edges) {
    families.get(find(blockOf.get(edge.parent.id) as CanvasBlock))?.edges.push(edge)
  }
  return [...families.values()]
}

function spansOverlap(aStart: number, aLength: number, bStart: number, bLength: number): boolean {
  return aStart < bStart + bLength && bStart < aStart + aLength
}

/**
 * The way a family already runs. A pair clearly beside each other counts for `x`, clearly above
 * and below for `y`, and a diagonal for neither. Down wins a tie, as that is where Enter continues.
 */
function flowAxis(blocks: CanvasBlock[], edges: LayoutEdge[]): CanvasAxis {
  let beside = 0
  let stacked = 0
  for (const { from, to, weight } of edges) {
    const a = blocks[from].rect
    const b = blocks[to].rect
    const sharesX = spansOverlap(a.x, a.w, b.x, b.w)
    const sharesY = spansOverlap(a.y, a.h, b.y, b.h)
    if (sharesY && !sharesX) beside += weight
    if (sharesX && !sharesY) stacked += weight
  }
  return beside > stacked ? 'x' : 'y'
}

/** The family's blocks in layers, relative to the corner of what they cover. */
function layOutFamily(family: TidyFamily, blockOf: ReadonlyMap<string, CanvasBlock>): TidyBox {
  const { blocks } = family
  const index = new Map(blocks.map((block, i) => [block, i]))
  const edges = family.edges.map(({ parent, child }): LayoutEdge => ({
    from: index.get(blockOf.get(parent.id) as CanvasBlock) as number,
    to: index.get(blockOf.get(child.id) as CanvasBlock) as number,
    weight: child.kind === 'expansion' ? EXPANSION_WEIGHT : CONTINUATION_WEIGHT
  }))
  const axis = flowAxis(blocks, edges)
  const nodes = blocks.map(({ rect }) =>
    axis === 'y'
      ? { mainLength: rect.h, crossLength: rect.w, crossAt: rect.x + rect.w / 2 }
      : { mainLength: rect.w, crossLength: rect.h, crossAt: rect.y + rect.h / 2 }
  )
  const positions = layeredLayout(nodes, edges, { layer: LAYER_GAP, sibling: SIBLING_GAP })
  const placed = blocks.map((block, i): PlacedBlock => {
    const { main, cross } = positions[i]
    return axis === 'y' ? { block, x: cross, y: main } : { block, x: main, y: cross }
  })
  const { w, h } = boundsOf(placed.map(placedRect)) as CanvasRect
  return { placed, w, h }
}

/* ---- Packing the families ---- */

/** Each box at the highest place with room, then the leftmost, inside `width`. */
function packBoxes(boxes: TidyBox[], width: number): CanvasPoint[] {
  const taken: CanvasRect[] = []
  const lowestClearY = (x: number, w: number, h: number): number => {
    let y = 0
    let hit: CanvasRect | undefined
    do {
      hit = taken.find(
        (other) =>
          spansOverlap(x - FAMILY_GAP, w + FAMILY_GAP * 2, other.x, other.w) &&
          spansOverlap(y - FAMILY_GAP, h + FAMILY_GAP * 2, other.y, other.h)
      )
      if (hit) y = hit.y + hit.h + FAMILY_GAP
    } while (hit)
    return y
  }
  return boxes.map(({ w, h }) => {
    const spot = [0, ...taken.map((other) => other.x + other.w + FAMILY_GAP)]
      .filter((x) => x === 0 || x + w <= width)
      .map((x) => ({ x, y: lowestClearY(x, w, h) }))
      .reduce((a, b) => (b.y < a.y || (b.y === a.y && b.x < a.x) ? b : a))
    taken.push({ ...spot, w, h })
    return spot
  })
}

function crossesProperly(a: CanvasPoint, b: CanvasPoint, c: CanvasPoint, d: CanvasPoint): boolean {
  const turn = (p: CanvasPoint, q: CanvasPoint, r: CanvasPoint): number =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  return turn(a, b, c) * turn(a, b, d) < 0 && turn(c, d, a) * turn(c, d, b) < 0
}

/** Whether a segment passes through the rectangle (Liang-Barsky clipping). */
function segmentHitsRect(a: CanvasPoint, b: CanvasPoint, rect: CanvasRect): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  let enter = 0
  let leave = 1
  const edges = [
    [-dx, a.x - rect.x],
    [dx, rect.x + rect.w - a.x],
    [-dy, a.y - rect.y],
    [dy, rect.y + rect.h - a.y]
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q <= 0) return false
    } else if (p < 0) {
      enter = Math.max(enter, q / p)
    } else {
      leave = Math.min(leave, q / p)
    }
  }
  return enter < leave
}

/** Every line still drawn once a group is laid out: seams between touching cards are not lines. */
function linesBetween(items: TidyItems, boxes: TidyBox[]): CardLine[] {
  const rects = new Map<string, CanvasRect>()
  const known = new Map(items.cards.map((card) => [card.id, card]))
  for (const box of boxes) {
    for (const { block, x, y } of box.placed) {
      const offset = { x: x - block.rect.x, y: y - block.rect.y }
      for (const id of block.cards) {
        const card = known.get(id)
        if (card) rects.set(id, shifted(card.rect, offset))
      }
    }
  }
  const sameBox = (a: string, b: string): boolean =>
    boxes.some((box) => box.placed.some(({ block }) => block.cards.has(a) && block.cards.has(b)))
  const parentLines = items.cards.flatMap((card): CardLine[] => {
    const parent =
      card.kind === 'message' ? card.parentId : card.kind === 'expansion' ? card.hostId : undefined
    return parent ? [[parent, card.id]] : []
  })
  return [
    ...parentLines.filter(([a, b]) => {
      const one = rects.get(a)
      const two = rects.get(b)
      return one && two && !sameBox(a, b) && !sharesSide(one, two)
    }),
    ...items.links.map((link): CardLine => [link.from, link.to]),
    ...askedAboutRelations(items.cards).map((line): CardLine => [line.from, line.to])
  ].filter(([a, b]) => a !== b && rects.has(a) && rects.has(b))
}

/** What an order of boxes costs: crossings, then lines over other cards, then line length. */
function orderCost(
  order: TidyBox[],
  spots: CanvasPoint[],
  lines: CardLine[],
  items: TidyItems
): number {
  const rects = new Map<string, CanvasRect>()
  const byId = new Map(items.cards.map((card) => [card.id, card]))
  order.forEach((box, i) => {
    for (const { block, x, y } of box.placed) {
      const offset = { x: x + spots[i].x - block.rect.x, y: y + spots[i].y - block.rect.y }
      for (const id of block.cards) {
        const card = byId.get(id)
        if (card) rects.set(id, shifted(card.rect, offset))
      }
    }
  })
  const center = (id: string): CanvasPoint => centerOf(rects.get(id) as CanvasRect)
  let cost = 0
  lines.forEach(([a, b], i) => {
    const from = center(a)
    const to = center(b)
    cost += Math.hypot(to.x - from.x, to.y - from.y)
    for (const [id, rect] of rects) {
      if (id !== a && id !== b && segmentHitsRect(from, to, rect)) cost += OVER_CARD_COST
    }
    for (const [c, d] of lines.slice(i + 1)) {
      if (a === c || a === d || b === c || b === d) continue
      if (crossesProperly(from, to, center(c), center(d))) cost += CROSSING_COST
    }
  })
  return cost
}

/** Families with lines between them next to each other, then swaps while one crosses fewer lines. */
function orderBoxes(
  boxes: TidyBox[],
  lines: CardLine[],
  items: TidyItems,
  width: number
): TidyBox[] {
  const boxOf = new Map<string, TidyBox>()
  for (const box of boxes) {
    for (const { block } of box.placed) {
      for (const id of block.cards) boxOf.set(id, box)
    }
  }
  const neighbours = new Map<TidyBox, TidyBox[]>(boxes.map((box) => [box, []]))
  for (const [a, b] of lines) {
    const one = boxOf.get(a) as TidyBox
    const two = boxOf.get(b) as TidyBox
    if (one !== two) {
      neighbours.get(one)?.push(two)
      neighbours.get(two)?.push(one)
    }
  }
  const order: TidyBox[] = []
  const visit = (box: TidyBox): void => {
    if (order.includes(box)) return
    order.push(box)
    for (const next of neighbours.get(box) as TidyBox[]) visit(next)
  }
  boxes.forEach(visit)
  if (lines.length < 2) return order

  const movable = order.flatMap((box, i) =>
    (neighbours.get(box) as TidyBox[]).length > 0 ? [i] : []
  )
  const reach = movable.length <= FULL_SEARCH_FAMILIES ? movable.length : NEAR_SEARCH_REACH
  let best = orderCost(order, packBoxes(order, width), lines, items)
  for (let pass = 0; pass < ORDER_PASSES; pass++) {
    let improved = false
    for (let i = 0; i < movable.length; i++) {
      for (let j = i + 1; j < Math.min(i + 1 + reach, movable.length); j++) {
        const [a, b] = [movable[i], movable[j]]
        ;[order[a], order[b]] = [order[b], order[a]]
        const cost = orderCost(order, packBoxes(order, width), lines, items)
        if (cost < best) {
          best = cost
          improved = true
        } else {
          ;[order[a], order[b]] = [order[b], order[a]]
        }
      }
    }
    if (!improved) break
  }
  return order
}

function movesAnything(items: TidyItems, result: CanvasArrangeResult): boolean {
  if (!result.ok) return false
  const standing = new Map([...items.cards, ...items.frames].map((item) => [item.id, item.rect]))
  return [...result.cards, ...result.frames].some(({ id, rect }) => {
    const before = standing.get(id)
    return !before || before.x !== rect.x || before.y !== rect.y
  })
}

/**
 * Tidies the selection, or everything without one. Attached cards are straightened, each family
 * is drawn in layers, and families are packed apart. Lines to anything staying put do not count,
 * and what stays is cleared by moving the result down. Refuses when nothing would move, such as
 * a canvas where every card is attached.
 */
export function tidySelection(
  items: TidyItems,
  selected?: ReadonlySet<string>
): CanvasArrangeResult {
  const ids =
    selected ??
    new Set([...items.cards.map((card) => card.id), ...items.frames.map((frame) => frame.id)])
  const found = blocksFor(items, ids)
  if (found.length === 0) return { ok: false }
  const straight = straightenBlocks(items.cards, found)
  const tidied: TidyItems = {
    ...items,
    cards: items.cards.map((card) => ({ ...card, rect: straight.get(card.id) ?? card.rect }))
  }
  const blocks = found.map(
    (block) => ({ ...block, rect: movingBounds(tidied, block) as CanvasRect }) as CanvasBlock
  )
  const bounds = boundsOf(blocks.map((block) => block.rect)) as CanvasRect

  const blockOf = new Map(
    blocks.flatMap((block) => [...block.cards].map((id) => [id, block] as const))
  )
  const families = familiesOf(blocks, parentEdges(tidied, blockOf), blockOf)
  // Size first keeps a second tidy from reshuffling; reading order only separates equals.
  const boxes = families
    .map((family) => ({
      box: layOutFamily(family, blockOf),
      at: boundsOf(family.blocks.map((block) => block.rect)) as CanvasRect
    }))
    .sort((a, b) => b.box.h - a.box.h || b.box.w - a.box.w || a.at.y - b.at.y || a.at.x - b.at.x)
    .map(({ box }) => box)

  const area = boxes.reduce((sum, { w, h }) => sum + (w + FAMILY_GAP) * (h + FAMILY_GAP), 0)
  const widest = Math.max(...boxes.map((box) => box.w))
  const width = Math.max(Math.sqrt(area * TIDY_ASPECT), widest)
  const order = orderBoxes(boxes, linesBetween(tidied, boxes), tidied, width)
  const spots = packBoxes(order, width)

  const packed = order.flatMap((box, i) =>
    box.placed.map((item) => ({ ...item, x: item.x + spots[i].x, y: item.y + spots[i].y }))
  )
  const moving = new Set(blocks.flatMap((block) => [...block.cards]))
  const packedBounds = boundsOf(packed.map(placedRect)) as CanvasRect
  const landing = rectClearOf(
    { ...packedBounds, x: bounds.x, y: bounds.y },
    cardRects(tidied.cards, moving),
    CLEARANCE
  )
  const result = settleBlocks(
    tidied,
    packed.map((item) => ({ ...item, x: item.x + landing.x, y: item.y + landing.y }))
  )
  return result.ok && movesAnything(items, result) ? result : { ok: false }
}
