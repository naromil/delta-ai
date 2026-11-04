/**
 * Moving several things at once: alignment, distribution, tidying and duplication.
 *
 * The unit is a block: a selected card with what is joined to it, or a frame with what
 * it holds. Blocks move rigidly, so joined cards stay joined and nothing leaves a frame.
 * Arranging spaces out what it moves and may land it over what stays. Everything is pure.
 */
import type {
  CanvasCard,
  CanvasFrame,
  CanvasLayout,
  CanvasLink,
  CanvasMessageCard,
  CanvasMoveUpdate,
  CanvasNoteCard,
  CanvasRect
} from './canvas'
import { cardRects, rectClearOf, rectsOverlap } from './canvas'
import type { CanvasMoving } from './canvas-selection'
import { boundsOf, movingBounds, movingForSelection } from './canvas-selection'
import type { Turn } from './conversation'

type CanvasItems = Pick<CanvasLayout, 'cards' | 'frames'>

export type CanvasAlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'
export type CanvasAxis = 'x' | 'y'

export interface CanvasFrameUpdate {
  id: string
  rect: CanvasRect
}

export type CanvasArrangeResult =
  { ok: true; cards: CanvasMoveUpdate[]; frames: CanvasFrameUpdate[] } | { ok: false }

interface CanvasBlock extends CanvasMoving {
  rect: CanvasRect
}

interface PlacedBlock {
  block: CanvasBlock
  x: number
  y: number
}

const LENGTH: Readonly<Record<CanvasAxis, 'w' | 'h'>> = { x: 'w', y: 'h' }
/** Space between blocks that an arrangement had to separate. */
const ARRANGE_GAP = 24
const TIDY_GAP = 48
/** The shape a tidied canvas aims for, roughly a window's. */
const TIDY_ASPECT = 1.6

function sharesAny(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const id of a) {
    if (b.has(id)) return true
  }
  return false
}

/** One block per selected item, with blocks that share anything merged. */
function blocksFor(items: CanvasItems, selected: ReadonlySet<string>): CanvasBlock[] {
  const merged: CanvasMoving[] = []
  for (const id of selected) {
    let moving = movingForSelection(items, new Set([id]))
    if (moving.cards.size === 0 && moving.frames.size === 0) continue
    for (let i = merged.length - 1; i >= 0; i--) {
      const other = merged[i]
      if (sharesAny(moving.cards, other.cards) || sharesAny(moving.frames, other.frames)) {
        moving = {
          cards: new Set([...moving.cards, ...other.cards]),
          frames: new Set([...moving.frames, ...other.frames])
        }
        merged.splice(i, 1)
      }
    }
    merged.push(moving)
  }
  return merged.flatMap((moving) => {
    const rect = movingBounds(items, moving)
    return rect ? [{ ...moving, rect }] : []
  })
}

/** How many things in a selection can move independently: arranging needs at least two. */
export function selectionBlockCount(items: CanvasItems, selected: ReadonlySet<string>): number {
  return blocksFor(items, selected).length
}

/** Turns where each block lands into moves. */
function settleBlocks(items: CanvasItems, placed: PlacedBlock[]): CanvasArrangeResult {
  const cardDelta = new Map<string, { dx: number; dy: number }>()
  const frameDelta = new Map<string, { dx: number; dy: number }>()
  for (const { block, x, y } of placed) {
    const delta = { dx: x - block.rect.x, dy: y - block.rect.y }
    for (const id of block.cards) cardDelta.set(id, delta)
    for (const id of block.frames) frameDelta.set(id, delta)
  }
  const shifted = (id: string, rect: CanvasRect, deltas: typeof cardDelta): CanvasRect => {
    const delta = deltas.get(id)
    return delta ? { ...rect, x: rect.x + delta.dx, y: rect.y + delta.dy } : rect
  }
  return {
    ok: true,
    cards: items.cards
      .filter((card) => cardDelta.has(card.id))
      .map((card) => ({ id: card.id, rect: shifted(card.id, card.rect, cardDelta) })),
    frames: items.frames
      .filter((frame) => frameDelta.has(frame.id))
      .map((frame) => ({ id: frame.id, rect: shifted(frame.id, frame.rect, frameDelta) }))
  }
}

/** Slides blocks along `axis`, in order, until none overlaps one placed before it. */
function separateAlong(placed: PlacedBlock[], axis: CanvasAxis): PlacedBlock[] {
  const box = ({ block, x, y }: PlacedBlock): CanvasRect => ({ ...block.rect, x, y })
  const sorted = [...placed].sort((a, b) => a[axis] - b[axis])
  const done: PlacedBlock[] = []
  for (const item of sorted) {
    let current = item
    let hit = done.find((other) => rectsOverlap(box(current), box(other)))
    while (hit) {
      const pushed: number = hit[axis] + hit.block.rect[LENGTH[axis]] + ARRANGE_GAP
      current = { ...current, [axis]: pushed }
      hit = done.find((other) => rectsOverlap(box(current), box(other)))
    }
    done.push(current)
  }
  return done
}

/**
 * Lines the selection up along one edge or centre. Blocks that would then collide are
 * spaced out across the other axis, so aligning a row's left edges makes a column.
 */
export function alignSelection(
  items: CanvasItems,
  selected: ReadonlySet<string>,
  edge: CanvasAlignEdge
): CanvasArrangeResult {
  const blocks = blocksFor(items, selected)
  const bounds = boundsOf(blocks.map((block) => block.rect))
  if (blocks.length < 2 || !bounds) return { ok: false }
  const horizontal = edge === 'left' || edge === 'center' || edge === 'right'
  const placed = blocks.map((block): PlacedBlock => {
    const { x, y, w, h } = block.rect
    if (edge === 'left') return { block, x: bounds.x, y }
    if (edge === 'center') return { block, x: bounds.x + (bounds.w - w) / 2, y }
    if (edge === 'right') return { block, x: bounds.x + bounds.w - w, y }
    if (edge === 'top') return { block, x, y: bounds.y }
    if (edge === 'middle') return { block, x, y: bounds.y + (bounds.h - h) / 2 }
    return { block, x, y: bounds.y + bounds.h - h }
  })
  return settleBlocks(items, separateAlong(placed, horizontal ? 'y' : 'x'))
}

/** Even gaps along an axis, with the two outermost blocks staying where they are. */
export function distributeSelection(
  items: CanvasItems,
  selected: ReadonlySet<string>,
  axis: CanvasAxis
): CanvasArrangeResult {
  const blocks = blocksFor(items, selected)
  if (blocks.length < 3) return { ok: false }
  const length = LENGTH[axis]
  const sorted = [...blocks].sort((a, b) => a.rect[axis] - b.rect[axis])
  const first = sorted[0].rect
  const last = sorted[sorted.length - 1].rect
  const span = last[axis] + last[length] - first[axis]
  const used = sorted.reduce((sum, block) => sum + block.rect[length], 0)
  const gap = Math.max((span - used) / (sorted.length - 1), 0)
  let cursor = first[axis]
  const placed = sorted.map((block): PlacedBlock => {
    const at = cursor
    cursor += block.rect[length] + gap
    return axis === 'x' ? { block, x: at, y: block.rect.y } : { block, x: block.rect.x, y: at }
  })
  return settleBlocks(items, placed)
}

/**
 * Packs blocks into rows in reading order, starting where they start now. Without a
 * selection it tidies everything. What stays put is cleared by moving the result down.
 */
export function tidySelection(
  items: CanvasItems,
  selected?: ReadonlySet<string>
): CanvasArrangeResult {
  const ids =
    selected ??
    new Set([...items.cards.map((card) => card.id), ...items.frames.map((frame) => frame.id)])
  const blocks = blocksFor(items, ids)
  const bounds = boundsOf(blocks.map((block) => block.rect))
  if (blocks.length === 0 || !bounds) return { ok: false }

  const area = blocks.reduce((sum, { rect }) => sum + (rect.w + TIDY_GAP) * (rect.h + TIDY_GAP), 0)
  const widest = Math.max(...blocks.map((block) => block.rect.w))
  const rowWidth = Math.max(Math.sqrt(area * TIDY_ASPECT), widest)
  const sorted = [...blocks].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)

  let x = 0
  let y = 0
  let rowHeight = 0
  const packed = sorted.map((block): PlacedBlock => {
    if (x > 0 && x + block.rect.w > rowWidth) {
      x = 0
      y += rowHeight + TIDY_GAP
      rowHeight = 0
    }
    const placed = { block, x, y }
    x += block.rect.w + TIDY_GAP
    rowHeight = Math.max(rowHeight, block.rect.h)
    return placed
  })

  const moving = {
    cards: new Set(blocks.flatMap((block) => [...block.cards])),
    frames: new Set(blocks.flatMap((block) => [...block.frames]))
  }
  const packedBounds = boundsOf(
    packed.map(({ block, x: px, y: py }) => ({ ...block.rect, x: px, y: py }))
  ) as CanvasRect
  const landing = rectClearOf(
    { ...packedBounds, x: bounds.x, y: bounds.y },
    cardRects(items.cards, moving.cards),
    TIDY_GAP
  )
  return settleBlocks(
    items,
    packed.map((item) => ({ ...item, x: item.x + landing.x, y: item.y + landing.y }))
  )
}

/* ---- Duplicating ---- */

export interface CanvasDuplicate {
  cards: CanvasCard[]
  turns: Turn[]
  frames: CanvasFrame[]
  links: CanvasLink[]
  /** The new top-level items, to select. */
  ids: string[]
}

export interface CanvasDuplicateIds {
  newId: () => string
  newTurnId: () => number
  /** Assistant turns still being written, which cannot be copied. */
  streamingTurnIds: ReadonlySet<number>
}

/**
 * Copies of the selected messages, notes and frames, beside the originals and clear of
 * everything. A copied message keeps the session it continues, so it is a branch; its
 * expansions stay behind, as they are anchored in the original's turn.
 */
export function duplicateSelection(
  layout: Pick<CanvasLayout, 'cards' | 'frames' | 'links'>,
  turns: Turn[],
  selected: ReadonlySet<string>,
  ids: CanvasDuplicateIds
): CanvasDuplicate | null {
  const moving = movingForSelection(layout, selected)
  const frames = layout.frames.filter((frame) => moving.frames.has(frame.id))
  const chosen = layout.cards.filter(
    (card) =>
      card.kind !== 'expansion' &&
      (selected.has(card.id) || moving.frames.size > 0) &&
      moving.cards.has(card.id) &&
      !(card.kind === 'message' && ids.streamingTurnIds.has(card.turnId))
  ) as Array<CanvasMessageCard | CanvasNoteCard>
  const bounds = boundsOf([...chosen.map((card) => card.rect), ...frames.map((f) => f.rect)])
  if (!bounds) return null

  const landing = rectClearOf(
    { ...bounds, x: bounds.x + bounds.w + TIDY_GAP },
    cardRects(layout.cards),
    ARRANGE_GAP
  )
  const shift = (rect: CanvasRect): CanvasRect => ({
    ...rect,
    x: rect.x + landing.x - bounds.x,
    y: rect.y + landing.y - bounds.y
  })

  const idMap = new Map(chosen.map((card) => [card.id, ids.newId()]))
  const newTurns: Turn[] = []
  const cards = chosen.map((card): CanvasCard => {
    const id = idMap.get(card.id) as string
    if (card.kind === 'note') return { ...card, id, rect: shift(card.rect) }
    const copyTurn = (turnId: number): number => {
      const copy = ids.newTurnId()
      const turn = turns.find((item) => item.id === turnId)
      if (turn) newTurns.push({ ...turn, id: copy, expansions: [] })
      return copy
    }
    const userTurnId = copyTurn(card.userTurnId)
    const turnId = copyTurn(card.turnId)
    const parentId = card.parentId === undefined ? undefined : idMap.get(card.parentId)
    return {
      ...card,
      id,
      rect: shift(card.rect),
      userTurnId,
      turnId,
      ...(parentId !== undefined ? { parentId } : {})
    }
  })
  const newFrames = frames.map((frame): CanvasFrame => ({
    ...frame,
    id: ids.newId(),
    rect: shift(frame.rect)
  }))
  const links = layout.links.flatMap((link): CanvasLink[] => {
    const to = idMap.get(link.to)
    // A copy reads what the original read, even when the source itself was not copied.
    const from = idMap.get(link.from) ?? (link.context ? link.from : undefined)
    return from && to ? [{ ...link, id: ids.newId(), from, to }] : []
  })
  return {
    cards,
    turns: newTurns,
    frames: newFrames,
    links,
    ids: [...cards.map((card) => card.id), ...newFrames.map((frame) => frame.id)]
  }
}
