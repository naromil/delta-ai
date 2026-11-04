/**
 * Straightening attached cards: a small clean-up of the inside of a block. Cards stay attached
 * and keep their sizes; only where they meet changes, so edges line up instead of nearly lining
 * up. A session's seams are never given up, and a result no cleaner than what stands is dropped,
 * so straightening twice changes nothing. A block holding a frame is left alone, as what a frame
 * holds is decided by geometry. Everything is pure.
 */
import type { CanvasCard, CanvasRect, CanvasSide } from './canvas'
import { rectsOverlap, sharedSide } from './canvas'
import type { CanvasMoving } from './canvas-selection'

type Alignment = 'start' | 'end'

/** Two touching cards: `b` stands against `side` of `a`. */
interface Attachment {
  a: CanvasCard
  b: CanvasCard
  side: CanvasSide
}

const DESCENT_PASSES = 4
/** Distance under which two edges count as one line, and a touch as a touch. */
const TOUCH = 1
/** Costs, in order of how much worse each is. */
const OVERLAP_COST = 1e6
const LOST_SEAM_COST = 1e9
const CONTACT_COST = 1e3
const LINE_COST = 10
/** Only separate otherwise equal results: prefer starts, then whatever moves least. */
const END_ALIGN_COST = 1
const MOVEMENT_COST = 0.001

function isSession(one: CanvasCard, other: CanvasCard): boolean {
  const continues = (child: CanvasCard, parent: CanvasCard): boolean =>
    (child.kind === 'message' && child.parentId === parent.id) ||
    (child.kind === 'expansion' && child.hostId === parent.id)
  return continues(one, other) || continues(other, one)
}

/** Every touching pair, with what a session runs through first. */
function attachmentsOf(cards: CanvasCard[]): Attachment[] {
  const all = cards.flatMap((a, i) =>
    cards.slice(i + 1).flatMap((b): Attachment[] => {
      const side = sharedSide(a.rect, b.rect)
      return side ? [{ a, b, side }] : []
    })
  )
  return [...all.filter((x) => isSession(x.a, x.b)), ...all.filter((x) => !isSession(x.a, x.b))]
}

const OPPOSITE: Readonly<Record<CanvasSide, CanvasSide>> = {
  right: 'left',
  left: 'right',
  top: 'bottom',
  bottom: 'top'
}

/** The attachments that reach every card once, as `a` placed before `b`. */
function spanningTree(root: CanvasCard, attachments: Attachment[]): Attachment[] {
  const reached = new Set([root.id])
  const tree: Attachment[] = []
  for (;;) {
    const next = attachments.find((x) => reached.has(x.a.id) !== reached.has(x.b.id))
    if (!next) return tree
    const forward = reached.has(next.a.id)
    const edge = forward ? next : { a: next.b, b: next.a, side: OPPOSITE[next.side] }
    reached.add(edge.b.id)
    tree.push(edge)
  }
}

function placeAgainst(
  anchor: CanvasRect,
  card: CanvasRect,
  side: CanvasSide,
  alignment: Alignment
): CanvasRect {
  if (side === 'left' || side === 'right') {
    const x = side === 'right' ? anchor.x + anchor.w : anchor.x - card.w
    return { ...card, x, y: alignment === 'start' ? anchor.y : anchor.y + anchor.h - card.h }
  }
  const y = side === 'bottom' ? anchor.y + anchor.h : anchor.y - card.h
  return { ...card, y, x: alignment === 'start' ? anchor.x : anchor.x + anchor.w - card.w }
}

function drawTree(
  root: CanvasCard,
  tree: Attachment[],
  alignments: Alignment[]
): Map<string, CanvasRect> {
  const rects = new Map([[root.id, root.rect]])
  tree.forEach(({ a, b, side }, i) => {
    rects.set(b.id, placeAgainst(rects.get(a.id) as CanvasRect, b.rect, side, alignments[i]))
  })
  return rects
}

/** Whether two rectangles meet along a stretch of a side, however short. */
function inContact(a: CanvasRect, b: CanvasRect): boolean {
  const overlap = (s1: number, l1: number, s2: number, l2: number): number =>
    Math.min(s1 + l1, s2 + l2) - Math.max(s1, s2)
  const meetsX = Math.abs(a.x + a.w - b.x) <= TOUCH || Math.abs(b.x + b.w - a.x) <= TOUCH
  const meetsY = Math.abs(a.y + a.h - b.y) <= TOUCH || Math.abs(b.y + b.h - a.y) <= TOUCH
  return (
    (meetsX && overlap(a.y, a.h, b.y, b.h) > TOUCH) ||
    (meetsY && overlap(a.x, a.w, b.x, b.w) > TOUCH)
  )
}

function distinctLines(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.filter((value, i) => i === 0 || value - sorted[i - 1] > TOUCH).length
}

/** How untidy a drawing is: overlaps, then lost and accidental contact, then separate edges. */
function untidiness(cards: CanvasCard[], rects: ReadonlyMap<string, CanvasRect>): number {
  const at = (card: CanvasCard): CanvasRect => rects.get(card.id) as CanvasRect
  let cost = 0
  cards.forEach((a, i) => {
    for (const b of cards.slice(i + 1)) {
      const was = sharedSide(a.rect, b.rect) !== undefined
      const is = sharedSide(at(a), at(b)) !== undefined
      if (rectsOverlap(at(a), at(b))) cost += OVERLAP_COST
      if (was && !is) cost += isSession(a, b) ? LOST_SEAM_COST : CONTACT_COST
      if (!was && inContact(at(a), at(b))) cost += CONTACT_COST
    }
  })
  const xs = cards.flatMap((card) => [at(card).x, at(card).x + at(card).w])
  const ys = cards.flatMap((card) => [at(card).y, at(card).y + at(card).h])
  return cost + (distinctLines(xs) + distinctLines(ys)) * LINE_COST
}

function straightenedBlock(cards: CanvasCard[]): Map<string, CanvasRect> | null {
  if (cards.length < 2) return null
  const root = cards[0]
  const tree = spanningTree(root, attachmentsOf(cards))
  if (tree.length !== cards.length - 1) return null

  const total = (alignments: Alignment[]): number => {
    const rects = drawTree(root, tree, alignments)
    const moved = cards.reduce((sum, card) => {
      const rect = rects.get(card.id) as CanvasRect
      return sum + Math.abs(rect.x - card.rect.x) + Math.abs(rect.y - card.rect.y)
    }, 0)
    const ends = alignments.filter((alignment) => alignment === 'end').length
    return untidiness(cards, rects) + ends * END_ALIGN_COST + moved * MOVEMENT_COST
  }
  const alignments = tree.map((): Alignment => 'start')
  let best = total(alignments)
  for (let pass = 0; pass < DESCENT_PASSES; pass++) {
    let improved = false
    for (let i = 0; i < alignments.length; i++) {
      const before = alignments[i]
      alignments[i] = before === 'start' ? 'end' : 'start'
      const cost = total(alignments)
      if (cost < best) {
        best = cost
        improved = true
      } else {
        alignments[i] = before
      }
    }
    if (!improved) break
  }

  const rects = drawTree(root, tree, alignments)
  const standing = new Map(cards.map((card) => [card.id, card.rect]))
  return untidiness(cards, rects) < untidiness(cards, standing) ? rects : null
}

/** New rectangles for the attached cards worth moving; the rest are not named. */
export function straightenBlocks(
  cards: CanvasCard[],
  blocks: CanvasMoving[]
): Map<string, CanvasRect> {
  const result = new Map<string, CanvasRect>()
  for (const block of blocks) {
    if (block.frames.size > 0) continue
    const inside = cards.filter((card) => block.cards.has(card.id))
    for (const [id, rect] of straightenedBlock(inside) ?? []) result.set(id, rect)
  }
  return result
}
