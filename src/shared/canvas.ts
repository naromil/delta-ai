/**
 * Canvas model: where each message and expansion sits on an infinite plane.
 *
 * A canvas is an ordinary conversation record (`source: 'canvas'`) whose turns
 * and expansions keep their usual shape, so saving, the curator and export need
 * nothing new. This layout is the only addition. Everything here is pure.
 */
import type { Turn } from './conversation'
import { buildExpandAncestorQuestion, buildCanvasFitNote } from './prompts'
import type { ProviderMessage } from './models'
import { expansionPath, findExpansionInTurns } from './rich-text'

export interface CanvasPoint {
  x: number
  y: number
}

export interface CanvasRect extends CanvasPoint {
  w: number
  h: number
}

/** Screen position = world position * zoom + (x, y). */
export interface CanvasViewport extends CanvasPoint {
  zoom: number
}

/** One question and its answer. */
export interface CanvasMessageCard {
  kind: 'message'
  id: string
  rect: CanvasRect
  userTurnId: number
  turnId: number
  /** The card this one continues; its session history is what the model sees. */
  parentId?: string
}

/** One expansion, drawn over its host's text (`inset`) or dragged out and linked. */
export interface CanvasExpansionCard {
  kind: 'expansion'
  id: string
  rect: CanvasRect
  turnId: number
  expansionId: number
  /** The card whose text holds the expanded term. */
  hostId: string
  inset: boolean
}

export type CanvasCard = CanvasMessageCard | CanvasExpansionCard

export interface CanvasLayout {
  cards: CanvasCard[]
  viewport: CanvasViewport
}

export type CanvasSide = 'right' | 'bottom' | 'left' | 'top'

export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 2
export const DEFAULT_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 }

export const MIN_MESSAGE_SIZE = { w: 200, h: 120 }
export const MIN_EXPANSION_SIZE = { w: 140, h: 84 }
export const DEFAULT_MESSAGE_SIZE = { w: 400, h: 280 }
export const DEFAULT_EXPANSION_SIZE = { w: 280, h: 150 }

/** Below this many world pixels of drag, a gesture counts as a click. */
export const CLICK_DRAG_LIMIT = 6

/** Sides this close count as shared, so a rounded rectangle cannot break a session. */
const SIDE_EPSILON = 1
/** Two rectangles must meet along at least this much of a side to share it. */
const MIN_SHARED_LENGTH = 24

/* ---- Rectangles ---- */

export function rectFromPoints(a: CanvasPoint, b: CanvasPoint): CanvasRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y)
  }
}

export function rectCenteredAt(point: CanvasPoint, size: { w: number; h: number }): CanvasRect {
  return { x: point.x - size.w / 2, y: point.y - size.h / 2, w: size.w, h: size.h }
}

/** Touching along a side is not overlapping: that is how a session is laid out. */
export function rectsOverlap(a: CanvasRect, b: CanvasRect): boolean {
  return (
    a.x + a.w - b.x > SIDE_EPSILON &&
    b.x + b.w - a.x > SIDE_EPSILON &&
    a.y + a.h - b.y > SIDE_EPSILON &&
    b.y + b.h - a.y > SIDE_EPSILON
  )
}

/** `rect` moved straight down until it overlaps none of `others`. */
export function rectClearBelow(rect: CanvasRect, others: CanvasRect[]): CanvasRect {
  const hit = others.find((other) => rectsOverlap(rect, other))
  return hit ? rectClearBelow({ ...rect, y: hit.y + hit.h }, others) : rect
}

/** `rect` moved straight down until it keeps at least `gap` from each of `others`. */
export function rectClearOf(rect: CanvasRect, others: CanvasRect[], gap: number): CanvasRect {
  const grown = others.map((other) => ({
    x: other.x - gap,
    y: other.y - gap,
    w: other.w + gap * 2,
    h: other.h + gap * 2
  }))
  return rectClearBelow(rect, grown)
}

/** The smallest rectangle holding both. */
export function unionRect(a: CanvasRect, b: CanvasRect): CanvasRect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y
  }
}

export function containsRect(outer: CanvasRect, inner: CanvasRect): boolean {
  return (
    inner.x >= outer.x - SIDE_EPSILON &&
    inner.y >= outer.y - SIDE_EPSILON &&
    inner.x + inner.w <= outer.x + outer.w + SIDE_EPSILON &&
    inner.y + inner.h <= outer.y + outer.h + SIDE_EPSILON
  )
}

export function containsPoint(rect: CanvasRect, point: CanvasPoint): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.w &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.h
  )
}

/** Moves `rect` inside `bounds`, shrinking it only when it cannot otherwise fit. */
export function clampRectInside(rect: CanvasRect, bounds: CanvasRect): CanvasRect {
  const w = Math.min(rect.w, bounds.w)
  const h = Math.min(rect.h, bounds.h)
  return {
    x: Math.min(Math.max(rect.x, bounds.x), bounds.x + bounds.w - w),
    y: Math.min(Math.max(rect.y, bounds.y), bounds.y + bounds.h - h),
    w,
    h
  }
}

export function clampPointInside(point: CanvasPoint, bounds: CanvasRect): CanvasPoint {
  return {
    x: Math.min(Math.max(point.x, bounds.x), bounds.x + bounds.w),
    y: Math.min(Math.max(point.y, bounds.y), bounds.y + bounds.h)
  }
}

function overlapLength(aStart: number, aLength: number, bStart: number, bLength: number): number {
  return Math.min(aStart + aLength, bStart + bLength) - Math.max(aStart, bStart)
}

export function sharesSide(a: CanvasRect, b: CanvasRect): boolean {
  const touchesVertically =
    Math.abs(a.x + a.w - b.x) <= SIDE_EPSILON || Math.abs(b.x + b.w - a.x) <= SIDE_EPSILON
  if (touchesVertically && overlapLength(a.y, a.h, b.y, b.h) >= MIN_SHARED_LENGTH) return true
  const touchesHorizontally =
    Math.abs(a.y + a.h - b.y) <= SIDE_EPSILON || Math.abs(b.y + b.h - a.y) <= SIDE_EPSILON
  return touchesHorizontally && overlapLength(a.x, a.w, b.x, b.w) >= MIN_SHARED_LENGTH
}

/* ---- Snapping ---- */

export interface SnapResult {
  rect: CanvasRect
  guidesX: number[]
  guidesY: number[]
}

function nearestCandidate(
  value: number,
  candidates: number[],
  threshold: number
): number | undefined {
  let best: number | undefined
  let bestDistance = threshold
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - value)
    if (distance <= bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

function edgeCandidates(others: CanvasRect[]): { xs: number[]; ys: number[] } {
  return {
    xs: others.flatMap((rect) => [rect.x, rect.x + rect.w]),
    ys: others.flatMap((rect) => [rect.y, rect.y + rect.h])
  }
}

/** Pulls each edge of a rectangle being drawn or resized onto a nearby card edge. */
export function snapEdges(rect: CanvasRect, others: CanvasRect[], threshold: number): SnapResult {
  const { xs, ys } = edgeCandidates(others)
  const left = nearestCandidate(rect.x, xs, threshold)
  const right = nearestCandidate(rect.x + rect.w, xs, threshold)
  const top = nearestCandidate(rect.y, ys, threshold)
  const bottom = nearestCandidate(rect.y + rect.h, ys, threshold)
  const x = left ?? rect.x
  const y = top ?? rect.y
  return {
    rect: { x, y, w: (right ?? rect.x + rect.w) - x, h: (bottom ?? rect.y + rect.h) - y },
    guidesX: [left, right].filter((value) => value !== undefined),
    guidesY: [top, bottom].filter((value) => value !== undefined)
  }
}

/** Slides a whole rectangle so one of its edges lands on a nearby card edge. */
export function snapMove(rect: CanvasRect, others: CanvasRect[], threshold: number): SnapResult {
  const { xs, ys } = edgeCandidates(others)
  const axis = (start: number, length: number, candidates: number[]): number | undefined => {
    const near = nearestCandidate(start, candidates, threshold)
    const far = nearestCandidate(start + length, candidates, threshold)
    if (near === undefined) return far === undefined ? undefined : far - length
    if (far === undefined) return near
    return Math.abs(near - start) <= Math.abs(far - (start + length)) ? near : far - length
  }
  const x = axis(rect.x, rect.w, xs)
  const y = axis(rect.y, rect.h, ys)
  const snapped = { ...rect, x: x ?? rect.x, y: y ?? rect.y }
  return {
    rect: snapped,
    guidesX: x === undefined ? [] : [xs.includes(x) ? x : x + rect.w],
    guidesY: y === undefined ? [] : [ys.includes(y) ? y : y + rect.h]
  }
}

/* ---- Words that fit ---- */

/*
 * Mirrors the card typography in canvas.css. Fitting is an estimate either way,
 * and the card body scrolls if the model overshoots.
 */
const CARD_PADDING_X = 32
const CARD_PADDING_Y = 24
const HEADER_PADDING_Y = 20
const HEADER_LINE_HEIGHT = 18
const HEADER_CHAR_WIDTH = 6.4
const HEADER_MAX_LINES = 2
const BODY_LINE_HEIGHT = 22
const BODY_CHAR_WIDTH = 7
const CHARS_PER_WORD = 6
/** Paragraph gaps and list indents use up some of the area. */
const AREA_FILL = 0.85
const MIN_WORDS = 10

function headerLines(width: number, captionChars: number): number {
  const lines = Math.ceil((captionChars * HEADER_CHAR_WIDTH) / Math.max(width, 1))
  return Math.min(Math.max(lines, 1), HEADER_MAX_LINES)
}

/** Roughly how many words of body text fit in a card, below its one or two line caption. */
export function estimateWords(rect: CanvasRect, captionChars = 0): number {
  const width = rect.w - CARD_PADDING_X
  const chrome =
    CARD_PADDING_Y + HEADER_PADDING_Y + headerLines(width, captionChars) * HEADER_LINE_HEIGHT
  const lines = Math.max(rect.h - chrome, 0) / BODY_LINE_HEIGHT
  const chars = (lines * Math.max(width, 0)) / BODY_CHAR_WIDTH
  const words = (chars / CHARS_PER_WORD) * AREA_FILL
  return Math.max(Math.round(words / 5) * 5, MIN_WORDS)
}

/** Adds the length to the newest user message, so stored turns never carry it. */
export function withCanvasFit(messages: ProviderMessage[], words: number): ProviderMessage[] {
  const index = messages.findLastIndex((message) => message.role === 'user')
  if (index < 0) return messages
  return messages.map((message, i) =>
    i === index
      ? { ...message, content: `${message.content}\n\n${buildCanvasFitNote(words)}` }
      : message
  )
}

/* ---- Card relationships ---- */

function cardById(cards: CanvasCard[], id: string | undefined): CanvasCard | undefined {
  return id === undefined ? undefined : cards.find((card) => card.id === id)
}

/** A card that stands on the plane itself, rather than sitting over another card's text. */
export function isTopLevel(card: CanvasCard): boolean {
  return card.kind === 'message' || !card.inset
}

export function topLevelRects(cards: CanvasCard[], except?: ReadonlySet<string>): CanvasRect[] {
  return cards.filter((card) => isTopLevel(card) && !except?.has(card.id)).map((card) => card.rect)
}

/**
 * Every card `rect` could continue, newest first. A rectangle touching several
 * sessions continues only one: the history of the others is not sent.
 */
export function continuationCandidates(rect: CanvasRect, cards: CanvasCard[]): CanvasCard[] {
  return cards.filter((card) => isTopLevel(card) && sharesSide(rect, card.rect)).reverse()
}

/** The newest card sharing a side with `rect`; none means `rect` starts a new session. */
export function continuationParent(rect: CanvasRect, cards: CanvasCard[]): CanvasCard | undefined {
  return continuationCandidates(rect, cards)[0]
}

/** A rectangle of `size` against one side of `rect`, sharing its top or left edge. */
export function rectAgainst(
  rect: CanvasRect,
  side: CanvasSide,
  size: { w: number; h: number }
): CanvasRect {
  const { x, y, w, h } = rect
  const slots: Record<CanvasSide, CanvasRect> = {
    right: { x: x + w, y, w: size.w, h: size.h },
    bottom: { x, y: y + h, w: size.w, h: size.h },
    left: { x: x - size.w, y, w: size.w, h: size.h },
    top: { x, y: y - size.h, w: size.w, h: size.h }
  }
  return slots[side]
}

/** A spot against one side of a card (its own size by default), or null when something is in the way. */
export function adjacentSlot(
  card: CanvasCard,
  side: CanvasSide,
  cards: CanvasCard[],
  size: { w: number; h: number } = card.rect
): CanvasRect | null {
  const slot = rectAgainst(card.rect, side, size)
  return topLevelRects(cards).some((other) => rectsOverlap(slot, other)) ? null : slot
}

/** The card a card came from: an expansion's host, or the card a message continues. */
export function sourceCardId(card: CanvasCard): string | undefined {
  return card.kind === 'expansion' ? card.hostId : card.parentId
}

function rectCenter(rect: CanvasRect): CanvasPoint {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
}

/**
 * The card arrow-key navigation lands on: the nearest one whose centre lies that
 * way, where sideways distance counts double so a straight line wins over a diagonal.
 */
export function nearestCardInDirection(
  cards: CanvasCard[],
  id: string,
  side: CanvasSide
): CanvasCard | undefined {
  const from = cardById(cards, id)
  if (!from) return undefined
  const origin = rectCenter(from.rect)
  let best: CanvasCard | undefined
  let bestScore = Infinity
  for (const card of cards) {
    if (card.id === id) continue
    const center = rectCenter(card.rect)
    const dx = center.x - origin.x
    const dy = center.y - origin.y
    const ahead = { right: dx, left: -dx, bottom: dy, top: -dy }[side]
    const sideways = side === 'right' || side === 'left' ? Math.abs(dy) : Math.abs(dx)
    if (ahead <= SIDE_EPSILON) continue
    const score = ahead + sideways * 2
    if (score < bestScore) {
      best = card
      bestScore = score
    }
  }
  return best
}

/** A card and what is drawn over its text: what an Alt+drag pulls out of its group. */
export function pulledOutCardIds(cards: CanvasCard[], id: string): Set<string> {
  const pulled = new Set([id])
  for (const cardId of pulled) {
    for (const other of cards) {
      if (other.kind === 'expansion' && other.inset && other.hostId === cardId) pulled.add(other.id)
    }
  }
  return pulled
}

/**
 * The cards that travel with `id` when it is dragged: everything touching it, so
 * adjacent rectangles move as one, and whatever is drawn over their text. Only touching
 * counts, so a card pulled out of its session stays out while its history still follows
 * `parentId`. A distant expansion stays and its link follows.
 */
export function movingCardIds(cards: CanvasCard[], id: string): Set<string> {
  const moving = new Set<string>()
  const visit = (cardId: string): void => {
    if (moving.has(cardId)) return
    const card = cardById(cards, cardId)
    if (!card) return
    moving.add(cardId)
    for (const other of cards) {
      if (other.kind === 'expansion' && other.inset && other.hostId === cardId) visit(other.id)
      if (isTopLevel(card) && isTopLevel(other) && sharesSide(card.rect, other.rect)) {
        visit(other.id)
      }
    }
  }
  visit(id)
  return moving
}

/** Everything that depends on a card: its continuations and its expansions. */
export function cascadeCardIds(cards: CanvasCard[], id: string): Set<string> {
  const cascade = new Set<string>()
  const visit = (cardId: string): void => {
    if (cascade.has(cardId)) return
    cascade.add(cardId)
    for (const other of cards) {
      if (other.kind === 'message' && other.parentId === cardId) visit(other.id)
      if (other.kind === 'expansion' && other.hostId === cardId) visit(other.id)
    }
  }
  visit(id)
  return cascade
}

/* ---- Dropping a dragged card ---- */

export interface CanvasMoveUpdate {
  id: string
  rect: CanvasRect
  inset?: boolean
}

export type CanvasMoveResult = { ok: true; updates: CanvasMoveUpdate[] } | { ok: false }

/**
 * Where a drag lands. An expansion stays over its host's text while it fits
 * inside, and becomes a separate linked card once it clears it. Nothing that
 * stands on the plane may overlap, so a drop halfway across an edge is refused.
 */
export function resolveMove(
  cards: CanvasCard[],
  draggedId: string,
  moving: ReadonlySet<string>,
  dx: number,
  dy: number
): CanvasMoveResult {
  const shifted = (rect: CanvasRect): CanvasRect => ({ ...rect, x: rect.x + dx, y: rect.y + dy })
  const dragged = cardById(cards, draggedId)
  const host = dragged?.kind === 'expansion' ? cardById(cards, dragged.hostId) : undefined
  const staysInset =
    dragged !== undefined &&
    host !== undefined &&
    !moving.has(host.id) &&
    containsRect(host.rect, shifted(dragged.rect))

  const obstacles = topLevelRects(cards, new Set([...moving, draggedId]))
  for (const card of cards) {
    if (!moving.has(card.id)) continue
    const standsOnPlane = card.id === draggedId ? !staysInset : isTopLevel(card)
    if (standsOnPlane && obstacles.some((rect) => rectsOverlap(shifted(card.rect), rect))) {
      return { ok: false }
    }
  }
  return {
    ok: true,
    updates: cards
      .filter((card) => moving.has(card.id))
      .map((card) => ({
        id: card.id,
        rect: shifted(card.rect),
        ...(card.id === draggedId && card.kind === 'expansion' ? { inset: staysInset } : {})
      }))
  }
}

/* ---- Resizing: adjacent cards stay joined ---- */

type CardRects = Map<string, CanvasRect>
type CardDimension = 'w' | 'h'

function standingRects(cards: CanvasCard[]): CardRects {
  return new Map(cards.filter(isTopLevel).map((card): [string, CanvasRect] => [card.id, card.rect]))
}

/** Whether `next` begins at the far edge of `from` along a dimension, sharing that side. */
function startsAtEdge(from: CanvasRect, next: CanvasRect, dimension: CardDimension): boolean {
  return dimension === 'w'
    ? Math.abs(from.x + from.w - next.x) <= SIDE_EPSILON &&
        overlapLength(from.y, from.h, next.y, next.h) >= MIN_SHARED_LENGTH
    : Math.abs(from.y + from.h - next.y) <= SIDE_EPSILON &&
        overlapLength(from.x, from.w, next.x, next.w) >= MIN_SHARED_LENGTH
}

/** Everything joined to `start` by shared sides, never passing through `barred`. */
function joinedTo(rects: CardRects, start: string, barred: ReadonlySet<string>): Set<string> {
  const joined = new Set([start])
  for (const id of joined) {
    const rect = rects.get(id) as CanvasRect
    for (const [otherId, other] of rects) {
      if (!barred.has(otherId) && sharesSide(rect, other)) joined.add(otherId)
    }
  }
  return joined
}

/**
 * What must move when the far edge of `id` does: the cards beyond that edge, and
 * whatever is joined to the rest only through them. A card also joined by another
 * route, such as one below a card alongside, keeps its place.
 */
function edgeFollowers(rects: CardRects, id: string, dimension: CardDimension): Set<string> {
  const beyond = new Set<string>()
  const carry = (fromId: string): void => {
    const from = rects.get(fromId) as CanvasRect
    for (const [otherId, other] of rects) {
      if (otherId === id || beyond.has(otherId) || !startsAtEdge(from, other, dimension)) continue
      beyond.add(otherId)
      carry(otherId)
    }
  }
  carry(id)
  if (beyond.size === 0) return beyond

  const anchored = joinedTo(rects, id, beyond)
  const followers = new Set(beyond)
  for (const joined of joinedTo(rects, id, new Set())) {
    if (!anchored.has(joined)) followers.add(joined)
  }
  return followers
}

/** How far followers can come back along a dimension before one reaches a card behind it. */
function roomBehind(
  rects: CardRects,
  id: string,
  followers: ReadonlySet<string>,
  dimension: CardDimension
): number {
  let room = Infinity
  for (const follower of followers) {
    const rect = rects.get(follower) as CanvasRect
    for (const [otherId, other] of rects) {
      if (otherId === id || followers.has(otherId)) continue
      const [start, otherEnd, crossing] =
        dimension === 'w'
          ? [rect.x, other.x + other.w, overlapLength(rect.y, rect.h, other.y, other.h)]
          : [rect.y, other.y + other.h, overlapLength(rect.x, rect.w, other.x, other.w)]
      if (crossing > 0 && otherEnd <= start + SIDE_EPSILON) {
        room = Math.min(room, Math.max(start - otherEnd, 0))
      }
    }
  }
  return room
}

/**
 * Gives a standing card a new width or height. Its followers keep their distance from
 * the moved edge. Shrinking stops where a follower can come back no further; growing
 * pushes whatever else is in the way, with what follows that. Returns false, with
 * `rects` of no further use, if a push cannot settle.
 */
function resizeAlong(
  rects: CardRects,
  id: string,
  dimension: CardDimension,
  length: number
): boolean {
  const start = rects.get(id) as CanvasRect
  const followers = edgeFollowers(rects, id, dimension)
  const wanted = length - start[dimension]
  const delta = wanted < 0 ? Math.max(wanted, -roomBehind(rects, id, followers, dimension)) : wanted
  if (delta === 0) return true
  const axis = dimension === 'w' ? 'x' : 'y'
  const shift = (cardId: string, distance: number): void => {
    const before = rects.get(cardId) as CanvasRect
    rects.set(cardId, { ...before, [axis]: before[axis] + distance })
  }

  rects.set(id, { ...start, [dimension]: start[dimension] + delta })
  for (const follower of followers) shift(follower, delta)
  if (delta < 0) return true

  // Everything moves one way and lands clear of what pushed it, so this settles;
  // the budget only guards against a stored layout that never could.
  let budget = rects.size * rects.size * 4
  const queue = [id, ...followers]
  while (queue.length > 0) {
    if (budget-- <= 0) return false
    const pusherId = queue.shift() as string
    for (const [otherId, other] of rects) {
      const pusher = rects.get(pusherId) as CanvasRect
      if (otherId === pusherId || !rectsOverlap(pusher, other)) continue
      if (otherId === id) return false
      const distance = pusher[axis] + pusher[dimension] - other[axis]
      const carried = [otherId, ...edgeFollowers(rects, otherId, dimension)].filter(
        (cardId) => cardId !== id
      )
      for (const cardId of carried) shift(cardId, distance)
      queue.push(...carried)
    }
  }
  return true
}

/** The moves that put `cards` where `rects` says, with inset cards riding on their hosts. */
function updatesFromRects(cards: CanvasCard[], rects: CardRects, id: string): CanvasMoveUpdate[] {
  return cards.flatMap((item): CanvasMoveUpdate[] => {
    if (item.id === id) return [{ id, rect: rects.get(id) as CanvasRect }]
    const standing = standingCard(cards, item)
    const now = standing ? rects.get(standing.id) : undefined
    if (!standing || !now) return []
    const dx = now.x - standing.rect.x
    const dy = now.y - standing.rect.y
    if (dx === 0 && dy === 0) return []
    return [{ id: item.id, rect: { ...item.rect, x: item.rect.x + dx, y: item.rect.y + dy } }]
  })
}

/** The top-level card an inset card ultimately sits on. */
function standingCard(cards: CanvasCard[], card: CanvasCard): CanvasCard | undefined {
  if (isTopLevel(card)) return card
  return card.kind === 'expansion'
    ? standingCard(cards, cardById(cards, card.hostId) ?? card)
    : undefined
}

/** The cards a resize of `id` carries along, whose edges it should therefore not snap to. */
export function resizeFollowerIds(cards: CanvasCard[], id: string): Set<string> {
  const rects = standingRects(cards)
  if (!rects.has(id)) return new Set()
  return new Set([...edgeFollowers(rects, id, 'w'), ...edgeFollowers(rects, id, 'h')])
}

/**
 * The moves that resize a card from its bottom-right corner, as close to `size` as
 * adjacent cards allow, or null when what it pushes cannot get out of the way.
 */
export function resizeCard(
  cards: CanvasCard[],
  id: string,
  size: { w: number; h: number }
): CanvasMoveUpdate[] | null {
  const card = cardById(cards, id)
  if (!card) return null
  if (!isTopLevel(card)) return [{ id, rect: { ...card.rect, ...size } }]
  const rects = standingRects(cards)
  if (!resizeAlong(rects, id, 'w', size.w) || !resizeAlong(rects, id, 'h', size.h)) return null
  return updatesFromRects(cards, rects, id)
}

/* ---- Fitting a card's height to its answer ---- */

/**
 * The moves that give a card the height its answer needs; its width never changes.
 * An inset card stays inside its host and a host never shrinks past what sits on
 * its text. A top-level card resizes as `resizeCard` does, so what is joined below
 * follows it. An empty result means nothing changes, and the body scrolls.
 */
export function fitCardHeight(
  cards: CanvasCard[],
  id: string,
  contentHeight: number
): CanvasMoveUpdate[] {
  const card = cardById(cards, id)
  if (!card) return []
  const minimum = card.kind === 'message' ? MIN_MESSAGE_SIZE.h : MIN_EXPANSION_SIZE.h
  const insetBottoms = cards.flatMap((other) =>
    other.kind === 'expansion' && other.inset && other.hostId === id
      ? [other.rect.y + other.rect.h - card.rect.y]
      : []
  )
  const wanted = Math.max(Math.ceil(contentHeight), minimum, ...insetBottoms)

  if (!isTopLevel(card)) {
    const host = card.kind === 'expansion' ? cardById(cards, card.hostId) : undefined
    const height = host ? Math.min(wanted, host.rect.y + host.rect.h - card.rect.y) : wanted
    if (height === card.rect.h || height < minimum) return []
    return [{ id, rect: { ...card.rect, h: height } }]
  }

  if (wanted === card.rect.h) return []
  const updates = resizeCard(cards, id, { w: card.rect.w, h: wanted }) ?? []
  const unchanged = updates.find((update) => update.id === id)?.rect.h === card.rect.h
  return unchanged ? [] : updates
}

/* ---- Session history ---- */

function expansionHistory(turns: Turn[], card: CanvasExpansionCard): Turn[] {
  const turn = turns.find((item) => item.id === card.turnId)
  const path = turn ? expansionPath(turn.expansions, card.expansionId) : null
  if (!path) return []
  return path.flatMap((node): Turn[] => [
    {
      id: -node.id,
      role: 'user',
      content: buildExpandAncestorQuestion(node.originalText, node.prompt),
      expansions: []
    },
    { id: -node.id, role: 'assistant', content: node.answer, expansions: [] }
  ])
}

/**
 * The linear conversation leading up to and including a card. Session history
 * follows `parentId`, so a canvas can branch without its branches seeing each other.
 */
export function turnsThroughCard(cards: CanvasCard[], turns: Turn[], id: string): Turn[] {
  const card = cardById(cards, id)
  if (!card) return []
  if (card.kind === 'message') {
    const before = card.parentId === undefined ? [] : turnsThroughCard(cards, turns, card.parentId)
    const own = turns.filter((turn) => turn.id === card.userTurnId || turn.id === card.turnId)
    return [...before, ...own]
  }
  const message = cards.find((other) => other.kind === 'message' && other.turnId === card.turnId)
  return [
    ...(message ? turnsThroughCard(cards, turns, message.id) : []),
    ...expansionHistory(turns, card)
  ]
}

/* ---- Links ---- */

/** A curve from a term to the facing side of its expansion, leaving and arriving squarely. */
export function linkPath(from: CanvasPoint, to: CanvasRect): string {
  const centerX = to.x + to.w / 2
  const centerY = to.y + to.h / 2
  const horizontal = Math.abs(from.x - centerX) / to.w >= Math.abs(from.y - centerY) / to.h
  const end = horizontal
    ? { x: from.x < centerX ? to.x : to.x + to.w, y: centerY }
    : { x: centerX, y: from.y < centerY ? to.y : to.y + to.h }
  const reach = Math.max(Math.hypot(end.x - from.x, end.y - from.y) * 0.4, 24)
  const c1 = horizontal
    ? { x: from.x + Math.sign(end.x - from.x) * reach, y: from.y }
    : { x: from.x, y: from.y + Math.sign(end.y - from.y) * reach }
  const c2 = horizontal
    ? { x: end.x - Math.sign(end.x - from.x) * reach, y: end.y }
    : { x: end.x, y: end.y - Math.sign(end.y - from.y) * reach }
  return `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`
}

/* ---- Viewport ---- */

export function screenToWorld(viewport: CanvasViewport, point: CanvasPoint): CanvasPoint {
  return { x: (point.x - viewport.x) / viewport.zoom, y: (point.y - viewport.y) / viewport.zoom }
}

/** Zooms while keeping the world point under `anchor` where it is on screen. */
export function zoomAt(
  viewport: CanvasViewport,
  anchor: CanvasPoint,
  zoom: number
): CanvasViewport {
  const next = Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM)
  const world = screenToWorld(viewport, anchor)
  return { x: anchor.x - world.x * next, y: anchor.y - world.y * next, zoom: next }
}

/*
 * Chromium reports a pinch as Ctrl+wheel with deltaY = 100 * ln(scale), so this rate
 * follows the fingers. A mouse notch reports far more, so the clamp holds it to one step.
 */
const WHEEL_ZOOM_RATE = 0.01
const MAX_WHEEL_ZOOM_DELTA = 25

/** What one Ctrl+wheel event or pinch update multiplies the zoom by. */
export function wheelZoomFactor(deltaY: number): number {
  const delta = Math.min(Math.max(deltaY, -MAX_WHEEL_ZOOM_DELTA), MAX_WHEEL_ZOOM_DELTA)
  return Math.exp(-delta * WHEEL_ZOOM_RATE)
}

const VIEWPORT_CHASE_MS = 55
const SETTLED_PX = 0.25
const SETTLED_ZOOM = 0.0005

/**
 * One frame of easing towards `target`, returning `target` itself on arrival. All three
 * values take the same fraction, which keeps fixed whatever point both ends agree on, so
 * the world under the pointer stays under the pointer throughout a zoom.
 */
export function chaseViewport(
  current: CanvasViewport,
  target: CanvasViewport,
  elapsedMs: number
): CanvasViewport {
  const t = 1 - Math.exp(-elapsedMs / VIEWPORT_CHASE_MS)
  const next = {
    x: current.x + (target.x - current.x) * t,
    y: current.y + (target.y - current.y) * t,
    zoom: current.zoom + (target.zoom - current.zoom) * t
  }
  const settled =
    Math.abs(target.x - next.x) < SETTLED_PX &&
    Math.abs(target.y - next.y) < SETTLED_PX &&
    Math.abs(target.zoom - next.zoom) < SETTLED_ZOOM
  return settled ? target : next
}

const GRID_SPACING = 28
const MIN_GRID_SCREEN_SPACING = 16

/** Dot spacing on screen; it doubles rather than let the dots crowd when zoomed out. */
export function gridSpacing(zoom: number): number {
  let spacing = GRID_SPACING * zoom
  while (spacing < MIN_GRID_SCREEN_SPACING) spacing *= 2
  return spacing
}

const FIT_MARGIN = 64

/** The viewport showing every rectangle, never zoomed in past 100%. */
export function fitViewport(
  rects: CanvasRect[],
  size: { width: number; height: number }
): CanvasViewport {
  if (rects.length === 0) return DEFAULT_VIEWPORT
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.w))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.h))
  const zoom = Math.max(
    Math.min(
      (size.width - FIT_MARGIN * 2) / Math.max(right - left, 1),
      (size.height - FIT_MARGIN * 2) / Math.max(bottom - top, 1),
      1
    ),
    MIN_ZOOM
  )
  return {
    x: (size.width - (right - left) * zoom) / 2 - left * zoom,
    y: (size.height - (bottom - top) * zoom) / 2 - top * zoom,
    zoom
  }
}

/** The smallest pan that brings a rectangle on screen; the same viewport when it already is. */
export function revealRect(
  viewport: CanvasViewport,
  rect: CanvasRect,
  size: { width: number; height: number }
): CanvasViewport {
  const axis = (offset: number, start: number, length: number, available: number): number => {
    const low = start * viewport.zoom + offset
    const high = low + length * viewport.zoom
    if (low >= FIT_MARGIN && high <= available - FIT_MARGIN) return offset
    if (high - low > available - FIT_MARGIN * 2 || low < FIT_MARGIN) {
      return offset + FIT_MARGIN - low
    }
    return offset + available - FIT_MARGIN - high
  }
  return {
    ...viewport,
    x: axis(viewport.x, rect.x, rect.w, size.width),
    y: axis(viewport.y, rect.y, rect.h, size.height)
  }
}

/** The part of the plane currently on screen. */
export function visibleWorldRect(
  viewport: CanvasViewport,
  size: { width: number; height: number }
): CanvasRect {
  const topLeft = screenToWorld(viewport, { x: 0, y: 0 })
  return { ...topLeft, w: size.width / viewport.zoom, h: size.height / viewport.zoom }
}

/** Whether a rectangle fits on screen at `zoom`, inside the margin `revealRect` keeps. */
export function fitsOnScreen(
  rect: CanvasRect,
  zoom: number,
  size: { width: number; height: number }
): boolean {
  return (
    rect.w * zoom <= size.width - FIT_MARGIN * 2 && rect.h * zoom <= size.height - FIT_MARGIN * 2
  )
}

/* ---- Load boundary ---- */

function isRect(value: unknown): value is CanvasRect {
  if (typeof value !== 'object' || value === null) return false
  const { x, y, w, h } = value as Record<string, unknown>
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(w) &&
    Number.isFinite(h) &&
    (w as number) > 0 &&
    (h as number) > 0
  )
}

function isCardSound(value: unknown, turns: Turn[]): value is CanvasCard {
  if (typeof value !== 'object' || value === null) return false
  const card = value as Partial<CanvasMessageCard> & Partial<CanvasExpansionCard>
  if (typeof card.id !== 'string' || !isRect(card.rect)) return false
  const hasTurn = (id: unknown): boolean => turns.some((turn) => turn.id === id)
  if (card.kind === 'message') return hasTurn(card.userTurnId) && hasTurn(card.turnId)
  return (
    card.kind === 'expansion' &&
    typeof card.hostId === 'string' &&
    typeof card.inset === 'boolean' &&
    typeof card.expansionId === 'number' &&
    findExpansionInTurns(turns, card.expansionId)?.turn.id === card.turnId
  )
}

function dropOrphans(cards: CanvasCard[]): CanvasCard[] {
  const ids = new Set(cards.map((card) => card.id))
  const kept = cards.filter((card) => card.kind === 'message' || ids.has(card.hostId))
  return kept.length === cards.length ? cards : dropOrphans(kept)
}

/** A stored layout is never trusted: a card that lost its turn or host is left out. */
export function normalizeCanvasLayout(raw: unknown, turns: Turn[]): CanvasLayout {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<CanvasLayout>
  const cards = dropOrphans(
    (Array.isArray(value.cards) ? value.cards : []).filter((card) => isCardSound(card, turns))
  )
  const ids = new Set(cards.map((card) => card.id))
  const viewport = value.viewport
  const viewportOk =
    Number.isFinite(viewport?.x) && Number.isFinite(viewport?.y) && Number.isFinite(viewport?.zoom)
  return {
    cards: cards.map((card) => {
      if (card.kind !== 'message' || card.parentId === undefined || ids.has(card.parentId)) {
        return card
      }
      // The session it continued is gone; it stands on its own now.
      return {
        kind: 'message',
        id: card.id,
        rect: card.rect,
        userTurnId: card.userTurnId,
        turnId: card.turnId
      }
    }),
    viewport: viewportOk
      ? {
          x: viewport!.x,
          y: viewport!.y,
          zoom: Math.min(Math.max(viewport!.zoom, MIN_ZOOM), MAX_ZOOM)
        }
      : DEFAULT_VIEWPORT
  }
}
