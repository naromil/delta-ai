/**
 * What a selection on the canvas covers: which items a marquee catches, what moves when
 * a selection is dragged, and the text of the selected cards. Everything here is pure.
 */
import type {
  CanvasCard,
  CanvasColor,
  CanvasFrame,
  CanvasLayout,
  CanvasPoint,
  CanvasRect
} from './canvas'
import {
  containsPoint,
  containsRect,
  hiddenInsetIds,
  isTopLevel,
  movingCardIds,
  pulledOutCardIds,
  rectsOverlap,
  unionRect
} from './canvas'
import type { CanvasSourceExcerpt } from './prompts'
import { findExpansionInTurns, flattenMarkdown } from './rich-text'
import type { Turn } from './conversation'

type CanvasItems = Pick<CanvasLayout, 'cards' | 'frames'>

export interface CanvasMoving {
  cards: Set<string>
  frames: Set<string>
}

/** The most text of one card that goes with a question about it. */
const SOURCE_TEXT_LIMIT = 6000

export function boundsOf(rects: CanvasRect[]): CanvasRect | null {
  return rects.length === 0 ? null : rects.reduce(unionRect)
}

/** What a marquee catches: cards it touches and, as they are large, frames it wholly covers. */
export function marqueeHits(items: CanvasItems, marquee: CanvasRect): string[] {
  const hidden = hiddenInsetIds(items.cards)
  return [
    ...items.cards
      .filter((card) => isTopLevel(card) && !hidden.has(card.id))
      .filter((card) => rectsOverlap(card.rect, marquee))
      .map((card) => card.id),
    ...items.frames.filter((frame) => containsRect(marquee, frame.rect)).map((frame) => frame.id)
  ]
}

/** The cards standing wholly inside a frame. */
export function cardsInsideFrame(cards: CanvasCard[], frame: CanvasFrame): CanvasCard[] {
  return cards.filter((card) => isTopLevel(card) && containsRect(frame.rect, card.rect))
}

function framesInside(frames: CanvasFrame[], outer: CanvasFrame): CanvasFrame[] {
  return frames.filter((frame) => frame.id !== outer.id && containsRect(outer.rect, frame.rect))
}

/**
 * What moves when a selection is dragged. A frame takes what stands inside it, frames
 * included. Each card brings what is joined to it, or with `pulledOut` only what is
 * drawn over its text. An inset card selected without its host stays out of a group,
 * as it could not be carried off its host's text.
 */
export function movingForSelection(
  items: CanvasItems,
  selected: ReadonlySet<string>,
  pulledOut = false
): CanvasMoving {
  const frames = new Set<string>()
  const seeds = new Set(
    items.cards.filter((card) => selected.has(card.id)).map((card) => card.id as string)
  )
  const addFrame = (frame: CanvasFrame): void => {
    if (frames.has(frame.id)) return
    frames.add(frame.id)
    for (const card of cardsInsideFrame(items.cards, frame)) seeds.add(card.id)
    for (const inner of framesInside(items.frames, frame)) addFrame(inner)
  }
  for (const frame of items.frames) {
    if (selected.has(frame.id)) addFrame(frame)
  }

  const cards = new Set<string>()
  for (const id of seeds) {
    const card = items.cards.find((item) => item.id === id)
    if (card?.kind === 'expansion' && card.inset && seeds.size > 1 && !seeds.has(card.hostId)) {
      continue
    }
    const moving = pulledOut ? pulledOutCardIds(items.cards, id) : movingCardIds(items.cards, id)
    for (const movingId of moving) cards.add(movingId)
  }
  return { cards, frames }
}

/** The cards a selection speaks for: those chosen, and what chosen frames hold. */
export function selectedCards(items: CanvasItems, selected: ReadonlySet<string>): CanvasCard[] {
  const covered = new Set(selected)
  for (const frame of items.frames) {
    if (selected.has(frame.id)) {
      for (const card of cardsInsideFrame(items.cards, frame)) covered.add(card.id)
    }
  }
  return items.cards.filter((card) => covered.has(card.id))
}

/** The rectangle that holds everything in a moving set, for snapping it as one. */
export function movingBounds(items: CanvasItems, moving: CanvasMoving): CanvasRect | null {
  return boundsOf([
    ...items.cards
      .filter((card) => moving.cards.has(card.id) && isTopLevel(card))
      .map((card) => card.rect),
    ...items.frames.filter((frame) => moving.frames.has(frame.id)).map((frame) => frame.rect)
  ])
}

/** The cards a card's session history runs through, nearest first, not counting itself. */
export function sessionAncestorIds(cards: CanvasCard[], id: string): Set<string> {
  const ancestors = new Set<string>()
  const byId = new Map(cards.map((card) => [card.id, card]))
  let card = byId.get(id)
  while (card && card.kind !== 'note') {
    const next: string | undefined = card.kind === 'expansion' ? card.hostId : card.parentId
    if (next === undefined || ancestors.has(next) || next === id) break
    ancestors.add(next)
    card = byId.get(next)
  }
  return ancestors
}

/** The card under a point: one drawn over another's text before the one it sits on. */
export function cardAtPoint(cards: CanvasCard[], point: CanvasPoint): CanvasCard | undefined {
  const hidden = hiddenInsetIds(cards)
  const hits = cards.filter((card) => !hidden.has(card.id) && containsPoint(card.rect, point))
  return hits.find((card) => !isTopLevel(card)) ?? hits.at(-1)
}

/** A card's title and body as text: a note has only a body. */
export function cardText(card: CanvasCard, turns: Turn[]): { title: string; body: string } {
  if (card.kind === 'note') return { title: '', body: card.text }
  if (card.kind === 'message') {
    return {
      title: turns.find((turn) => turn.id === card.userTurnId)?.content ?? '',
      body: turns.find((turn) => turn.id === card.turnId)?.content ?? ''
    }
  }
  const node = findExpansionInTurns(turns, card.expansionId)?.node
  const term = flattenMarkdown(node?.originalText ?? '')
  const question = node?.prompt?.trim()
  return { title: question ? `${term}: ${question}` : term, body: node?.answer ?? '' }
}

function inReadingOrder(cards: CanvasCard[]): CanvasCard[] {
  return [...cards].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
}

/** The selected cards as markdown, top to bottom, for the clipboard. */
export function selectionMarkdown(
  cards: CanvasCard[],
  turns: Turn[],
  selected: ReadonlySet<string>
): string {
  return inReadingOrder(cards.filter((card) => selected.has(card.id)))
    .map((card) => {
      const { title, body } = cardText(card, turns)
      return title.trim() === '' ? body.trim() : `### ${title.trim()}\n\n${body.trim()}`
    })
    .filter((block) => block !== '')
    .join('\n\n')
}

/** What the model is shown of the cards a question is about. */
export function sourceExcerpts(
  cards: CanvasCard[],
  turns: Turn[],
  ids: readonly string[]
): CanvasSourceExcerpt[] {
  const chosen = new Set(ids)
  return inReadingOrder(cards.filter((card) => chosen.has(card.id))).flatMap((card) => {
    const { title, body } = cardText(card, turns)
    if (body.trim() === '') return []
    const clipped = body.length > SOURCE_TEXT_LIMIT ? `${body.slice(0, SOURCE_TEXT_LIMIT)}…` : body
    return [{ title: flattenMarkdown(title), text: clipped }]
  })
}

/** The one colour a selection shares, for showing it as chosen; none when they differ. */
export function sharedColor(
  items: CanvasItems,
  selected: ReadonlySet<string>
): CanvasColor | undefined {
  const colors = [...items.cards, ...items.frames]
    .filter((item) => selected.has(item.id))
    .map((item) => item.color)
  const first = colors[0]
  return colors.every((color) => color === first) ? first : undefined
}
