/**
 * Undo and redo for a canvas, as patches rather than snapshots.
 *
 * Answers keep arriving while the user arranges things, so going back must not rewind
 * them. A patch names only what one action changed, and applying it leaves the rest,
 * streaming text and cards asked for since, as it finds it. Everything here is pure.
 */
import type { CanvasCard, CanvasFrame, CanvasLayout, CanvasLink } from './canvas'
import { isTopLevel, normalizeCanvasLayout, rectsOverlap } from './canvas'
import type { Turn } from './conversation'
import { finalizeTurns } from './rich-text'

export type CanvasSnapshot = Pick<CanvasLayout, 'cards' | 'frames' | 'links'> & { turns: Turn[] }

/** Identity means "unchanged": everything that edits a canvas copies only what it edits. */
interface Change<T extends { id: unknown }> {
  id: T['id']
  before?: T
  after?: T
  beforeIndex: number
  afterIndex: number
}

export interface CanvasPatch {
  label: string
  cards: Array<Change<CanvasCard>>
  frames: Array<Change<CanvasFrame>>
  links: Array<Change<CanvasLink>>
  turns: Array<Change<Turn>>
}

export type CanvasPatchDirection = 'undo' | 'redo'

export type CanvasPatchResult =
  | { ok: true; snapshot: CanvasSnapshot }
  /** `changed`: a turn it touches has moved on. `blocked`: something now stands in the way. */
  | { ok: false; reason: 'changed' | 'blocked' }

function diffList<T extends { id: unknown }>(before: T[], after: T[]): Array<Change<T>> {
  const beforeAt = new Map(before.map((item, index) => [item.id, index]))
  const afterAt = new Map(after.map((item, index) => [item.id, index]))
  const changes: Array<Change<T>> = []
  for (const [index, item] of before.entries()) {
    const other = afterAt.get(item.id)
    if (other === undefined) {
      changes.push({ id: item.id, before: item, beforeIndex: index, afterIndex: -1 })
    } else if (after[other] !== item) {
      changes.push({
        id: item.id,
        before: item,
        after: after[other],
        beforeIndex: index,
        afterIndex: other
      })
    }
  }
  for (const [index, item] of after.entries()) {
    if (!beforeAt.has(item.id)) {
      changes.push({ id: item.id, after: item, beforeIndex: -1, afterIndex: index })
    }
  }
  return changes
}

/** What an action changed, or null when it changed nothing. */
export function diffCanvas(
  label: string,
  before: CanvasSnapshot,
  after: CanvasSnapshot
): CanvasPatch | null {
  const patch: CanvasPatch = {
    label,
    cards: diffList(before.cards, after.cards),
    frames: diffList(before.frames, after.frames),
    links: diffList(before.links, after.links),
    // A restored turn comes back at rest: its stream was cancelled when it left. Only a
    // turn that changed is finalized, so one still streaming elsewhere never counts as changed.
    turns: diffList(before.turns, after.turns).map((change) =>
      change.before ? { ...change, before: finalizeTurns([change.before])[0] } : change
    )
  }
  const empty =
    patch.cards.length === 0 &&
    patch.frames.length === 0 &&
    patch.links.length === 0 &&
    patch.turns.length === 0
  return empty ? null : patch
}

function applyChanges<T extends { id: unknown }>(
  items: T[],
  changes: Array<Change<T>>,
  direction: CanvasPatchDirection
): T[] {
  const result = [...items]
  const undoing = direction === 'undo'
  const ordered = [...changes].sort((a, b) =>
    undoing ? a.beforeIndex - b.beforeIndex : a.afterIndex - b.afterIndex
  )
  for (const change of ordered) {
    const to = undoing ? change.before : change.after
    const index = result.findIndex((item) => item.id === change.id)
    if (to === undefined) {
      if (index >= 0) result.splice(index, 1)
    } else if (index >= 0) {
      result[index] = to
    } else if (undoing ? change.after === undefined : change.before === undefined) {
      // It comes back where it was; one that left in some other way stays gone.
      const at = undoing ? change.beforeIndex : change.afterIndex
      result.splice(Math.min(at, result.length), 0, to)
    }
  }
  return result
}

function overlappingPairs(cards: CanvasCard[]): Set<string> {
  const standing = cards.filter(isTopLevel)
  const pairs = new Set<string>()
  for (const [i, a] of standing.entries()) {
    for (const b of standing.slice(i + 1)) {
      if (rectsOverlap(a.rect, b.rect)) pairs.add([a.id, b.id].sort().join(' '))
    }
  }
  return pairs
}

/** Applies a patch to the canvas as it is now, not as it was when the patch was made. */
export function applyCanvasPatch(
  current: CanvasSnapshot,
  patch: CanvasPatch,
  direction: CanvasPatchDirection
): CanvasPatchResult {
  const undoing = direction === 'undo'
  for (const change of patch.turns) {
    const expected = undoing ? change.after : change.before
    const now = current.turns.find((turn) => turn.id === change.id)
    if (expected === undefined ? now !== undefined : now !== expected) {
      return { ok: false, reason: 'changed' }
    }
  }

  const turns = applyChanges(current.turns, patch.turns, direction)
  const layout = normalizeCanvasLayout(
    {
      cards: applyChanges(current.cards, patch.cards, direction),
      frames: applyChanges(current.frames, patch.frames, direction),
      links: applyChanges(current.links, patch.links, direction),
      viewport: { x: 0, y: 0, zoom: 1 }
    },
    turns
  )

  const had = overlappingPairs(current.cards)
  for (const pair of overlappingPairs(layout.cards)) {
    if (!had.has(pair)) return { ok: false, reason: 'blocked' }
  }
  return {
    ok: true,
    snapshot: { turns, cards: layout.cards, frames: layout.frames, links: layout.links }
  }
}
