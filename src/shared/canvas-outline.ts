/**
 * The canvas as a list: frames, then the sessions inside them, each card under the one
 * it came from. It is what the outline panel shows and what canvas search runs over.
 */
import type { CanvasCard, CanvasColor, CanvasFrame, CanvasLayout, CanvasPoint } from './canvas'
import { sourceCardId } from './canvas'
import { cardText, cardsInsideFrame } from './canvas-selection'
import type { Turn } from './conversation'
import { flattenMarkdown } from './rich-text'

export type CanvasOutlineKind = 'frame' | CanvasCard['kind']

export interface CanvasOutlineRow {
  id: string
  kind: CanvasOutlineKind
  label: string
  /** The text search looks through, flattened. */
  text: string
  depth: number
  color?: CanvasColor
}

export interface CanvasSearchHit extends CanvasOutlineRow {
  /** The words around the match, when it is not in the label. */
  snippet?: string
}

const LABEL_CHARS = 80
const SNIPPET_RADIUS = 50

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function byPosition(a: { rect: CanvasPoint }, b: { rect: CanvasPoint }): number {
  return a.rect.y - b.rect.y || a.rect.x - b.rect.x
}

function cardRow(card: CanvasCard, turns: Turn[], depth: number): CanvasOutlineRow {
  const { title, body } = cardText(card, turns)
  const flatBody = oneLine(flattenMarkdown(body))
  const flatTitle = oneLine(flattenMarkdown(title))
  return {
    id: card.id,
    kind: card.kind,
    label: (flatTitle || flatBody || 'Empty note').slice(0, LABEL_CHARS),
    text: flatTitle === '' ? flatBody : `${flatTitle} ${flatBody}`,
    depth,
    ...(card.color ? { color: card.color } : {})
  }
}

function frameRow(frame: CanvasFrame): CanvasOutlineRow {
  const title = oneLine(frame.title)
  return {
    id: frame.id,
    kind: 'frame',
    label: title || 'Untitled frame',
    text: title,
    depth: 0,
    ...(frame.color ? { color: frame.color } : {})
  }
}

/** Frames in reading order with what they hold, then everything outside any frame. */
export function canvasOutline(
  layout: Pick<CanvasLayout, 'cards' | 'frames'>,
  turns: Turn[]
): CanvasOutlineRow[] {
  const byId = new Map(layout.cards.map((card) => [card.id, card]))
  const children = new Map<string, CanvasCard[]>()
  const roots: CanvasCard[] = []
  for (const card of layout.cards) {
    const source = sourceCardId(card)
    if (source !== undefined && byId.has(source)) {
      children.set(source, [...(children.get(source) ?? []), card])
    } else {
      roots.push(card)
    }
  }

  const rows: CanvasOutlineRow[] = []
  const visit = (card: CanvasCard, depth: number): void => {
    rows.push(cardRow(card, turns, depth))
    for (const child of (children.get(card.id) ?? []).sort(byPosition)) visit(child, depth + 1)
  }

  const placed = new Set<string>()
  // The smallest frame claims a card first, so a nested frame keeps what it holds.
  const smallestFirst = [...layout.frames].sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h)
  const held = new Map<string, CanvasCard[]>()
  for (const frame of smallestFirst) {
    const inside = cardsInsideFrame(roots, frame).filter((card) => !placed.has(card.id))
    for (const card of inside) placed.add(card.id)
    held.set(frame.id, inside)
  }
  for (const frame of [...layout.frames].sort(byPosition)) {
    rows.push(frameRow(frame))
    for (const card of (held.get(frame.id) ?? []).sort(byPosition)) visit(card, 1)
  }
  for (const card of roots.filter((item) => !placed.has(item.id)).sort(byPosition)) visit(card, 0)
  return rows
}

function snippetAround(text: string, at: number, length: number): string {
  const start = Math.max(at - SNIPPET_RADIUS, 0)
  const end = Math.min(at + length + SNIPPET_RADIUS, text.length)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/** Rows holding every word of the query, in outline order. */
export function searchCanvasOutline(rows: CanvasOutlineRow[], query: string): CanvasSearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  return rows.flatMap((row): CanvasSearchHit[] => {
    const haystack = row.text.toLowerCase()
    if (!words.every((word) => haystack.includes(word))) return []
    const inLabel = words.every((word) => row.label.toLowerCase().includes(word))
    return [
      inLabel
        ? row
        : {
            ...row,
            snippet: snippetAround(row.text, haystack.indexOf(words[0]), words[0].length)
          }
    ]
  })
}
