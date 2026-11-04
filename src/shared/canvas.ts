/**
 * Canvas model: where each message and expansion sits on an infinite plane.
 *
 * A canvas is an ordinary conversation record (`source: 'canvas'`) whose turns
 * and expansions keep their usual shape, so saving, the curator and export need
 * nothing new. This layout is the only addition. Everything here is pure.
 */
import type { Turn } from './conversation'
import type { CanvasContextExcerpt, CanvasSourceExcerpt } from './prompts'
import {
  buildCanvasContextNote,
  buildCanvasFitNote,
  buildCanvasSourcesNote,
  buildExpandAncestorQuestion
} from './prompts'
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

export const CANVAS_COLORS = ['red', 'amber', 'green', 'teal', 'blue', 'violet'] as const
export type CanvasColor = (typeof CANVAS_COLORS)[number]

/** One question and its answer. */
export interface CanvasMessageCard {
  kind: 'message'
  id: string
  rect: CanvasRect
  userTurnId: number
  turnId: number
  /** The card this one continues; its session history is what the model sees. */
  parentId?: string
  /** Cards asked about: their text goes with the request, not their history. */
  sources?: string[]
  color?: CanvasColor
  /** Shown as its title alone; this is the height to return to. */
  collapsedFrom?: number
}

/** One expansion, linked from its term in `hostId`, and otherwise a card like any other. */
export interface CanvasExpansionCard {
  kind: 'expansion'
  id: string
  rect: CanvasRect
  turnId: number
  expansionId: number
  /** The card whose text holds the expanded term. */
  hostId: string
  color?: CanvasColor
  collapsedFrom?: number
}

/** The user's own text. It stands on the plane like a card, but holds no turn. */
export interface CanvasNoteCard {
  kind: 'note'
  id: string
  rect: CanvasRect
  text: string
  color?: CanvasColor
}

export type CanvasCard = CanvasMessageCard | CanvasExpansionCard | CanvasNoteCard

/** A titled region under the cards. What it holds is decided by geometry, at the moment it moves. */
export interface CanvasFrame {
  id: string
  rect: CanvasRect
  title: string
  color?: CanvasColor
}

/** What a link sends: the card at its start alone, or everything leading up to that card. */
export type CanvasLinkContext = 'card' | 'branch'

/** An arrow the user drew between two cards, labelled with how they relate. */
export interface CanvasLink {
  id: string
  from: string
  to: string
  label?: string
  /** Sends the start's text to the end's branch. Without it the arrow is only a drawing. */
  context?: CanvasLinkContext
}

export interface CanvasLayout {
  cards: CanvasCard[]
  viewport: CanvasViewport
  frames: CanvasFrame[]
  links: CanvasLink[]
  /** Standing cards brought forward, lowest first. Any card not named here is above them. */
  stack: string[]
}

export type CanvasSide = 'right' | 'bottom' | 'left' | 'top'

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 2
/** Below this zoom body text cannot be read, so a card shows its title at a legible size. */
export const FAR_ZOOM = 0.5
export const DEFAULT_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 }

export const MIN_MESSAGE_SIZE = { w: 200, h: 120 }
export const MIN_EXPANSION_SIZE = { w: 140, h: 84 }
export const DEFAULT_MESSAGE_SIZE = { w: 400, h: 280 }
export const DEFAULT_EXPANSION_SIZE = { w: 280, h: 150 }
export const MIN_NOTE_SIZE = { w: 100, h: 60 }
export const DEFAULT_NOTE_SIZE = { w: 240, h: 150 }
export const MIN_FRAME_SIZE = { w: 160, h: 100 }
/** Enough for a header holding one line of caption (see .canvas-card-header). */
export const COLLAPSED_CARD_HEIGHT = 40

/** Below this many world pixels of drag, a gesture counts as a click. */
export const CLICK_DRAG_LIMIT = 6

/** Sides this close count as shared, so a rounded rectangle cannot break a session. */
const SIDE_EPSILON = 1
/** Two rectangles must meet along at least this much of a side to share it. */
const MIN_SHARED_LENGTH = 24
/** A seam stops short of the rounded corners of the cards either side of it (`canvas.css`). */
const SEAM_CORNER = 6
const MIN_LINK_REACH = 48

/** A copy without one optional field, keeping the object's own type. */
export function withoutField<T extends object>(item: T, field: keyof T): T {
  const copy = { ...item }
  delete copy[field]
  return copy
}

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

/** The side of `a` that touches `b`, if they share enough of one to count as touching. */
export function sharedSide(a: CanvasRect, b: CanvasRect): CanvasSide | undefined {
  if (overlapLength(a.y, a.h, b.y, b.h) >= MIN_SHARED_LENGTH) {
    if (Math.abs(a.x + a.w - b.x) <= SIDE_EPSILON) return 'right'
    if (Math.abs(b.x + b.w - a.x) <= SIDE_EPSILON) return 'left'
  }
  if (overlapLength(a.x, a.w, b.x, b.w) >= MIN_SHARED_LENGTH) {
    if (Math.abs(a.y + a.h - b.y) <= SIDE_EPSILON) return 'bottom'
    if (Math.abs(b.y + b.h - a.y) <= SIDE_EPSILON) return 'top'
  }
  return undefined
}

export function sharesSide(a: CanvasRect, b: CanvasRect): boolean {
  return sharedSide(a, b) !== undefined
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
 * Mirrors the card typography in canvas.css, and was checked against answers laid out in the
 * real cards: it lands between what plain prose and prose with lists need. The card still fits
 * its height afterwards, so this only has to get the model close.
 */
const CARD_CHROME_Y = 3
const CARD_BODY_INSET_X = 34
const CARD_BODY_PADDING_Y = 24
const CARD_HEADER_INSET_X = 30
const HEADER_PADDING_Y = 20
const HEADER_LINE_HEIGHT = 18
const HEADER_MAX_LINES = 2
const BODY_FONT_SIZE = 14
const HEADER_FONT_SIZE = 12.5
const BODY_LINE_HEIGHT = 22
const PARAGRAPH_GAP = 8
/** Average width of body text when the renderer has not measured its real font. */
export const BODY_CHAR_WIDTH = 7
const CHARS_PER_WORD = 5.9
const WORDS_PER_PARAGRAPH = 45
/** A wrapped word leaves the end of each line empty, and a paragraph ends part way along one. */
const CHARS_LOST_PER_LINE = 2.5
const LINES_LOST_PER_PARAGRAPH = 0.5
const MIN_WORDS = 10

function headerLines(cardWidth: number, captionChars: number, charWidth: number): number {
  const width = Math.max(cardWidth - CARD_HEADER_INSET_X, 1)
  const headerCharWidth = (charWidth * HEADER_FONT_SIZE) / BODY_FONT_SIZE
  const lines = Math.ceil((captionChars * headerCharWidth) / width)
  return Math.min(Math.max(lines, 1), HEADER_MAX_LINES)
}

/**
 * Roughly how many words of body text fit in a card, below its one or two line caption.
 * `charWidth` is the body font's average character width, which varies by platform.
 */
export function estimateWords(
  rect: CanvasRect,
  captionChars = 0,
  charWidth = BODY_CHAR_WIDTH
): number {
  const chrome =
    CARD_CHROME_Y +
    HEADER_PADDING_Y +
    headerLines(rect.w, captionChars, charWidth) * HEADER_LINE_HEIGHT +
    CARD_BODY_PADDING_Y
  const lines = Math.max(rect.h - chrome, 0) / BODY_LINE_HEIGHT
  const lineChars = Math.max(
    Math.max(rect.w - CARD_BODY_INSET_X, 0) / charWidth - CHARS_LOST_PER_LINE,
    1
  )
  const paragraphLines =
    (WORDS_PER_PARAGRAPH * CHARS_PER_WORD) / lineChars +
    LINES_LOST_PER_PARAGRAPH +
    PARAGRAPH_GAP / BODY_LINE_HEIGHT
  const words = (lines / paragraphLines) * WORDS_PER_PARAGRAPH
  return Math.max(Math.round(words / 5) * 5, MIN_WORDS)
}

function withNoteBeforeQuestion(messages: ProviderMessage[], note: string): ProviderMessage[] {
  const index = messages.findLastIndex((message) => message.role === 'user')
  if (index < 0) return messages
  return messages.map((message, i) =>
    i === index ? { ...message, content: `${note}\n\n${message.content}` } : message
  )
}

/** Adds the cards asked about to the newest user message, so stored turns never carry them. */
export function withCanvasSources(
  messages: ProviderMessage[],
  sources: CanvasSourceExcerpt[]
): ProviderMessage[] {
  if (sources.length === 0) return messages
  return withNoteBeforeQuestion(messages, buildCanvasSourcesNote(sources))
}

/** Adds what is linked into the branch to the newest user message, like the cards asked about. */
export function withCanvasContext(
  messages: ProviderMessage[],
  items: CanvasContextExcerpt[]
): ProviderMessage[] {
  if (items.length === 0) return messages
  return withNoteBeforeQuestion(messages, buildCanvasContextNote(items))
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

export function cardRects(cards: CanvasCard[], except?: ReadonlySet<string>): CanvasRect[] {
  return cards.filter((card) => !except?.has(card.id)).map((card) => card.rect)
}

/**
 * Every card `rect` could continue, newest first. A rectangle touching several
 * sessions continues only one: the history of the others is not sent.
 */
export function continuationCandidates(rect: CanvasRect, cards: CanvasCard[]): CanvasCard[] {
  return cards.filter((card) => card.kind !== 'note' && sharesSide(rect, card.rect)).reverse()
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

/** The size of a card's `+`, which sits centred on its side; mirrors `.canvas-continue`. */
const CONTINUE_HANDLE_SIZE = 26

/** Whether a card's `+` on this side would sit on something rather than in open space. */
export function continueHandleBlocked(
  card: CanvasCard,
  side: CanvasSide,
  cards: CanvasCard[]
): boolean {
  const half = CONTINUE_HANDLE_SIZE / 2
  const { x, y, w, h } = card.rect
  const handle = {
    x: (side === 'right' ? x + w : x + w / 2) - half,
    y: (side === 'right' ? y + h / 2 : y + h) - half,
    w: CONTINUE_HANDLE_SIZE,
    h: CONTINUE_HANDLE_SIZE
  }
  return cardRects(cards, new Set([card.id])).some((rect) => rectsOverlap(handle, rect))
}

/** A spot against one side of a card (its own size by default), or null when something is in the way. */
export function adjacentSlot(
  card: CanvasCard,
  side: CanvasSide,
  cards: CanvasCard[],
  size: { w: number; h: number } = card.rect
): CanvasRect | null {
  const slot = rectAgainst(card.rect, side, size)
  return cardRects(cards).some((other) => rectsOverlap(slot, other)) ? null : slot
}

/** Which way each side of a draft can grow: away from the parent it is kept against. */
export function draftGrowth(side: CanvasSide | undefined): { x: 1 | -1; y: 1 | -1 } {
  return { x: side === 'left' ? -1 : 1, y: side === 'top' ? -1 : 1 }
}

/**
 * A draft after growing by `change`, with its far corner moving and the rest staying put.
 * Only the moving edges snap to `others`; a draft may grow over them.
 */
export function resizeDraftRect(
  start: CanvasRect,
  side: CanvasSide | undefined,
  change: { dw: number; dh: number },
  others: CanvasRect[],
  threshold: number
): SnapResult {
  const grow = draftGrowth(side)
  const startEdgeX = grow.x > 0 ? start.x : start.x + start.w
  const startEdgeY = grow.y > 0 ? start.y : start.y + start.h
  const { xs, ys } = edgeCandidates(others)
  const wanted = (edge: number, size: number, sign: number, candidates: number[]): number => {
    const near = nearestCandidate(edge + sign * size, candidates, threshold)
    return near === undefined ? size : sign * (near - edge)
  }
  const w = Math.max(
    wanted(startEdgeX, start.w + change.dw, grow.x, xs),
    Math.min(MIN_MESSAGE_SIZE.w, start.w)
  )
  const h = Math.max(
    wanted(startEdgeY, start.h + change.dh, grow.y, ys),
    Math.min(MIN_MESSAGE_SIZE.h, start.h)
  )
  const placed = (): CanvasRect => ({
    x: grow.x > 0 ? startEdgeX : startEdgeX - w,
    y: grow.y > 0 ? startEdgeY : startEdgeY - h,
    w,
    h
  })
  const rect = placed()
  const movingX = grow.x > 0 ? rect.x + rect.w : rect.x
  const movingY = grow.y > 0 ? rect.y + rect.h : rect.y
  return {
    rect,
    guidesX: threshold > 0 && xs.includes(movingX) ? [movingX] : [],
    guidesY: threshold > 0 && ys.includes(movingY) ? [movingY] : []
  }
}

/** The card a card came from: an expansion's host, or the card a message continues. */
export function sourceCardId(card: CanvasCard): string | undefined {
  if (card.kind === 'note') return undefined
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

/**
 * What an Alt+drag pulls out of its group: a card and its attached descendants. A child is
 * attached when it shares a side with its parent; one reached by a link stays, and so does
 * everything beyond it.
 */
export function pulledOutCardIds(cards: CanvasCard[], id: string): Set<string> {
  const pulled = new Set<string>()
  const visit = (cardId: string): void => {
    if (pulled.has(cardId)) return
    const card = cardById(cards, cardId)
    if (!card) return
    pulled.add(cardId)
    for (const other of cards) {
      const isChild =
        (other.kind === 'message' && other.parentId === cardId) ||
        (other.kind === 'expansion' && other.hostId === cardId)
      if (isChild && sharesSide(card.rect, other.rect)) visit(other.id)
    }
  }
  visit(id)
  return pulled
}

/**
 * What a Shift+drag moves: everything touching the card, so adjacent rectangles move as
 * one. Only touching counts, so a card pulled out of its session stays out while its
 * history still follows `parentId`, and a distant expansion stays and its link follows.
 */
export function movingCardIds(cards: CanvasCard[], id: string): Set<string> {
  const moving = new Set<string>()
  const visit = (cardId: string): void => {
    if (moving.has(cardId)) return
    const card = cardById(cards, cardId)
    if (!card) return
    moving.add(cardId)
    for (const other of cards) {
      if (sharesSide(card.rect, other.rect)) visit(other.id)
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
}

/** Where a drag lands. Cards may overlap, so any drop is allowed. */
export function resolveMove(
  cards: CanvasCard[],
  moving: ReadonlySet<string>,
  dx: number,
  dy: number
): CanvasMoveUpdate[] {
  return cards
    .filter((card) => moving.has(card.id))
    .map((card) => ({
      id: card.id,
      rect: { ...card.rect, x: card.rect.x + dx, y: card.rect.y + dy }
    }))
}

/* ---- Resizing: adjacent cards stay joined ---- */

type CardRects = Map<string, CanvasRect>
type CardDimension = 'w' | 'h'

function rectsById(cards: CanvasCard[]): CardRects {
  return new Map(cards.map((card): [string, CanvasRect] => [card.id, card.rect]))
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
  dimension: CardDimension,
  counts: (cardId: string) => boolean
): number {
  let room = Infinity
  for (const follower of followers) {
    const rect = rects.get(follower) as CanvasRect
    for (const [otherId, other] of rects) {
      if (otherId === id || followers.has(otherId) || !counts(otherId)) continue
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

type ResizeReach = 'joined' | 'everything'

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\n${b}` : `${b}\n${a}`
}

function overlappingPairs(rects: CardRects): Set<string> {
  const pairs = new Set<string>()
  const entries = [...rects]
  for (const [i, [aId, a]] of entries.entries()) {
    for (const [bId, b] of entries.slice(i + 1)) {
      if (rectsOverlap(a, b)) pairs.add(pairKey(aId, bId))
    }
  }
  return pairs
}

/**
 * Gives a standing card a new width or height. Its followers keep their distance from
 * the moved edge. Shrinking stops where a follower can come back no further, and growing
 * pushes what it newly reaches, with what follows that; cards already overlapping are left
 * that way. Both apply only to what `reach` covers: everything, or just the cards joined to
 * this one, which then never land on each other while it may cover the rest.
 * Returns false, with `rects` of no further use, if a push cannot settle.
 */
function resizeAlong(
  rects: CardRects,
  id: string,
  dimension: CardDimension,
  length: number,
  reach: ResizeReach
): boolean {
  const start = rects.get(id) as CanvasRect
  const followers = edgeFollowers(rects, id, dimension)
  const wanted = length - start[dimension]
  const joined = reach === 'joined' ? joinedTo(rects, id, new Set()) : null
  const counts = (cardId: string): boolean => joined === null || joined.has(cardId)
  const delta =
    wanted < 0 ? Math.max(wanted, -roomBehind(rects, id, followers, dimension, counts)) : wanted
  if (delta === 0) return true
  const settled = overlappingPairs(rects)
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
      if (otherId === pusherId || !counts(otherId) || !rectsOverlap(pusher, other)) continue
      if (settled.has(pairKey(pusherId, otherId))) continue
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

/** The moves that put `cards` where `rects` says. */
function updatesFromRects(cards: CanvasCard[], rects: CardRects, id: string): CanvasMoveUpdate[] {
  return cards.flatMap((card): CanvasMoveUpdate[] => {
    const rect = rects.get(card.id) as CanvasRect
    return card.id === id || rect.x !== card.rect.x || rect.y !== card.rect.y
      ? [{ id: card.id, rect }]
      : []
  })
}

/** The cards a resize of `id` carries along, whose edges it should therefore not snap to. */
export function resizeFollowerIds(cards: CanvasCard[], id: string): Set<string> {
  const rects = rectsById(cards)
  if (!rects.has(id)) return new Set()
  return new Set([...edgeFollowers(rects, id, 'w'), ...edgeFollowers(rects, id, 'h')])
}

function resizeMoves(
  cards: CanvasCard[],
  id: string,
  size: { w: number; h: number },
  reach: ResizeReach
): CanvasMoveUpdate[] | null {
  const card = cardById(cards, id)
  if (!card) return null
  const rects = rectsById(cards)
  const settled =
    resizeAlong(rects, id, 'w', size.w, reach) && resizeAlong(rects, id, 'h', size.h, reach)
  return settled ? updatesFromRects(cards, rects, id) : null
}

/**
 * The moves for a resize the user asked for, from a card's bottom-right corner. Cards
 * joined to it follow or are pushed aside, and it may end up over anything else.
 */
export function resizeCard(
  cards: CanvasCard[],
  id: string,
  size: { w: number; h: number }
): CanvasMoveUpdate[] {
  return resizeMoves(cards, id, size, 'joined') ?? []
}

/**
 * The moves for a change of size nobody aimed, such as an answer fitting its card, which
 * must not hide a neighbour: as close to `size` as adjacent cards allow, or null when
 * what it pushes cannot get out of the way.
 */
export function resizeCardKeepingClear(
  cards: CanvasCard[],
  id: string,
  size: { w: number; h: number }
): CanvasMoveUpdate[] | null {
  return resizeMoves(cards, id, size, 'everything')
}

/* ---- Stacking: which card is on top where they overlap ---- */

/** The cards, lowest first: those in `stack`, then the rest in the order they were made. */
function stackedCards(cards: CanvasCard[], stack: readonly string[]): CanvasCard[] {
  const named = new Set(stack)
  return [
    ...stack.flatMap((id) => cards.filter((card) => card.id === id)),
    ...cards.filter((card) => !named.has(card.id))
  ]
}

/** Each card's height in the pile. */
export function cardStackRanks(cards: CanvasCard[], stack: readonly string[]): Map<string, number> {
  return new Map(stackedCards(cards, stack).map((card, rank) => [card.id, rank]))
}

/**
 * The stack with `ids` on top, keeping their order among themselves.
 * The same array comes back when nothing covers them, so a click changes nothing to save.
 */
export function raisedStack(cards: CanvasCard[], stack: string[], ids: Iterable<string>): string[] {
  const raised = new Set(ids)
  const order = stackedCards(cards, stack)
  const covered = order.some(
    (card, index) =>
      raised.has(card.id) &&
      order
        .slice(index + 1)
        .some((above) => !raised.has(above.id) && rectsOverlap(card.rect, above.rect))
  )
  if (!covered) return stack
  const inOrder = order.map((card) => card.id)
  return [...inOrder.filter((id) => !raised.has(id)), ...inOrder.filter((id) => raised.has(id))]
}

/* ---- Fitting a card's height to its answer ---- */

/**
 * The moves that give a card the height its answer needs; its width never changes.
 * It resizes with `resizeCardKeepingClear`, so what is joined below follows it. An empty
 * result means nothing changes, and the body scrolls.
 */
export function fitCardHeight(
  cards: CanvasCard[],
  id: string,
  contentHeight: number
): CanvasMoveUpdate[] {
  const card = cardById(cards, id)
  // A note is the size the user made it, and a collapsed card has no body to fit.
  if (!card || card.kind === 'note' || card.collapsedFrom !== undefined) return []
  const minimum = card.kind === 'message' ? MIN_MESSAGE_SIZE.h : MIN_EXPANSION_SIZE.h
  const wanted = Math.max(Math.ceil(contentHeight), minimum)
  if (wanted === card.rect.h) return []
  const updates = resizeCardKeepingClear(cards, id, { w: card.rect.w, h: wanted }) ?? []
  const unchanged = updates.find((update) => update.id === id)?.rect.h === card.rect.h
  return unchanged ? [] : updates
}

/* ---- Collapsing a card to its title ---- */

/** The size a card has when open, whether or not it is collapsed now. */
export function openCardSize(card: CanvasCard): { w: number; h: number } {
  const collapsedFrom = card.kind === 'note' ? undefined : card.collapsedFrom
  return { w: card.rect.w, h: collapsedFrom ?? card.rect.h }
}

/**
 * Collapses or reopens a card through `resizeCard`, so what is joined below follows.
 * The same list comes back when nothing changes: a note cannot collapse, and a card
 * cannot reopen when what it would push cannot get out of the way.
 */
export function setCardCollapsed(
  cards: CanvasCard[],
  id: string,
  collapsed: boolean
): CanvasCard[] {
  const card = cardById(cards, id)
  if (!card || card.kind === 'note') return cards
  if ((card.collapsedFrom !== undefined) === collapsed) return cards
  const height = collapsed ? COLLAPSED_CARD_HEIGHT : openCardSize(card).h
  const updates = resizeCardKeepingClear(cards, id, { w: card.rect.w, h: height })
  if (!updates) return cards
  const rects = new Map(updates.map((update) => [update.id, update.rect]))
  return cards.map((item) => {
    const rect = rects.get(item.id) ?? item.rect
    if (item.id !== id || item.kind === 'note') return { ...item, rect }
    return collapsed
      ? { ...item, rect, collapsedFrom: item.rect.h }
      : { ...withoutField(item, 'collapsedFrom'), rect }
  })
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
  if (card.kind === 'note') return []
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

/**
 * The cards whose conversation a card follows, itself first: the same walk as
 * `turnsThroughCard`, as cards. A note has no conversation but still receives nothing else.
 */
export function sessionCardIds(cards: CanvasCard[], id: string | undefined): string[] {
  const path: string[] = []
  let card = cardById(cards, id)
  while (card && !path.includes(card.id)) {
    path.push(card.id)
    if (card.kind === 'note') break
    const { turnId }: { turnId: number } = card
    card =
      card.kind === 'message'
        ? cardById(cards, card.parentId)
        : cards.find((other) => other.kind === 'message' && other.turnId === turnId)
  }
  return path
}

/* ---- Links ---- */

/** A curve leaving and arriving squarely, heading `direction` (+1 or -1) along its axis. */
function squareCurve(
  from: CanvasPoint,
  to: CanvasPoint,
  horizontal: boolean,
  direction: number,
  reach: number
): string {
  const step = direction * reach
  const c1 = horizontal ? { x: from.x + step, y: from.y } : { x: from.x, y: from.y + step }
  const c2 = horizontal ? { x: to.x - step, y: to.y } : { x: to.x, y: to.y - step }
  return `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`
}

/** A curve from a term to the facing side of its expansion, leaving and arriving squarely. */
export function linkPath(from: CanvasPoint, to: CanvasRect): string {
  const centerX = to.x + to.w / 2
  const centerY = to.y + to.h / 2
  const horizontal = Math.abs(from.x - centerX) / to.w >= Math.abs(from.y - centerY) / to.h
  const end = horizontal
    ? { x: from.x < centerX ? to.x : to.x + to.w, y: centerY }
    : { x: centerX, y: from.y < centerY ? to.y : to.y + to.h }
  const direction = Math.sign(horizontal ? end.x - from.x : end.y - from.y)
  const reach = Math.max(Math.hypot(end.x - from.x, end.y - from.y) * 0.4, 24)
  return squareCurve(from, end, horizontal, direction, reach)
}

/**
 * How a card follows the one before it in its session, always shown one way: `seam` is
 * the boundary they share, and `link` a curve across whatever separates them. `side` is
 * the way the session travels, from the earlier card to `id`.
 */
export type CanvasContinuation =
  | { kind: 'seam'; id: string; start: CanvasPoint; end: CanvasPoint; side: CanvasSide }
  | {
      kind: 'link'
      id: string
      start: CanvasPoint
      end: CanvasPoint
      side: CanvasSide
      d: string
    }

function seamBetween(
  id: string,
  a: CanvasRect,
  b: CanvasRect,
  side: CanvasSide
): CanvasContinuation {
  if (side === 'left' || side === 'right') {
    const x = side === 'right' ? a.x + a.w : a.x
    return {
      kind: 'seam',
      id,
      side,
      start: { x, y: Math.max(a.y, b.y) + SEAM_CORNER },
      end: { x, y: Math.min(a.y + a.h, b.y + b.h) - SEAM_CORNER }
    }
  }
  const y = side === 'bottom' ? a.y + a.h : a.y
  return {
    kind: 'seam',
    id,
    side,
    start: { x: Math.max(a.x, b.x) + SEAM_CORNER, y },
    end: { x: Math.min(a.x + a.w, b.x + b.w) - SEAM_CORNER, y }
  }
}

/**
 * A curve between the facing sides of two cards. Two cards meeting at a corner have no
 * gap to cross, so the curve always bows out rather than lying along their boundary.
 */
function linkBetween(id: string, a: CanvasRect, b: CanvasRect): CanvasContinuation {
  const dx = b.x + b.w / 2 - (a.x + a.w / 2)
  const dy = b.y + b.h / 2 - (a.y + a.h / 2)
  const horizontal = Math.abs(dx) - (a.w + b.w) / 2 >= Math.abs(dy) - (a.h + b.h) / 2
  if (horizontal) {
    const start = { x: dx >= 0 ? a.x + a.w : a.x, y: a.y + a.h / 2 }
    const end = { x: dx >= 0 ? b.x : b.x + b.w, y: b.y + b.h / 2 }
    const reach = Math.max(Math.abs(end.x - start.x) / 2, MIN_LINK_REACH)
    const d = squareCurve(start, end, true, dx >= 0 ? 1 : -1, reach)
    return { kind: 'link', id, side: dx >= 0 ? 'right' : 'left', start, end, d }
  }
  const start = { x: a.x + a.w / 2, y: dy >= 0 ? a.y + a.h : a.y }
  const end = { x: b.x + b.w / 2, y: dy >= 0 ? b.y : b.y + b.h }
  const reach = Math.max(Math.abs(end.y - start.y) / 2, MIN_LINK_REACH)
  const d = squareCurve(start, end, false, dy >= 0 ? 1 : -1, reach)
  return { kind: 'link', id, side: dy >= 0 ? 'bottom' : 'top', start, end, d }
}

/** One entry per message that continues another card. */
export function canvasContinuations(cards: CanvasCard[]): CanvasContinuation[] {
  return cards.flatMap((card) => {
    if (card.kind === 'expansion') {
      // Apart from its host, an expansion's line runs to its term instead.
      const host = cardById(cards, card.hostId)
      const side = host && sharedSide(host.rect, card.rect)
      return host && side ? [seamBetween(card.id, host.rect, card.rect, side)] : []
    }
    if (card.kind !== 'message') return []
    const parent = cardById(cards, card.parentId)
    if (!parent) return []
    const side = sharedSide(parent.rect, card.rect)
    return [
      side
        ? seamBetween(card.id, parent.rect, card.rect, side)
        : linkBetween(card.id, parent.rect, card.rect)
    ]
  })
}

/**
 * The lines from cards asked about. The card a message continues already has its mark
 * from `canvasContinuations`, so it gets no second line.
 */
export function askedAboutRelations(cards: CanvasCard[]): Array<{ from: string; to: string }> {
  const ids = new Set(cards.map((card) => card.id))
  return cards.flatMap((card) => {
    if (card.kind !== 'message') return []
    const froms = new Set((card.sources ?? []).filter((id) => ids.has(id) && id !== card.parentId))
    return [...froms].map((from) => ({ from, to: card.id }))
  })
}

export interface ConnectorGeometry {
  d: string
  /** The curve's middle, where its label sits. */
  mid: CanvasPoint
}

/** A curve between the facing sides of two rectangles, leaving and arriving squarely. */
export function connectorGeometry(from: CanvasRect, to: CanvasRect): ConnectorGeometry {
  const a = rectCenter(from)
  const b = rectCenter(to)
  const dx = b.x - a.x
  const dy = b.y - a.y
  const horizontal = Math.abs(dx) / (from.w + to.w) >= Math.abs(dy) / (from.h + to.h)
  const start = horizontal
    ? { x: dx >= 0 ? from.x + from.w : from.x, y: a.y }
    : { x: a.x, y: dy >= 0 ? from.y + from.h : from.y }
  const end = horizontal
    ? { x: dx >= 0 ? to.x : to.x + to.w, y: b.y }
    : { x: b.x, y: dy >= 0 ? to.y : to.y + to.h }
  const reach = Math.max(Math.hypot(end.x - start.x, end.y - start.y) * 0.4, 24)
  const c1 = horizontal
    ? { x: start.x + Math.sign(dx || 1) * reach, y: start.y }
    : { x: start.x, y: start.y + Math.sign(dy || 1) * reach }
  const c2 = horizontal
    ? { x: end.x - Math.sign(dx || 1) * reach, y: end.y }
    : { x: end.x, y: end.y - Math.sign(dy || 1) * reach }
  return {
    d: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`,
    mid: {
      x: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8,
      y: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8
    }
  }
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

/** The widest of a wrapped inline element's line boxes; the earliest wins a tie. */
export function longestLine<T extends { width: number; height: number }>(
  lines: readonly T[]
): T | undefined {
  const visible = lines.filter((line) => line.width > 0 && line.height > 0)
  return visible.reduce<T | undefined>(
    (best, line) => (best === undefined || line.width > best.width ? line : best),
    undefined
  )
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

function isColor(value: unknown): value is CanvasColor {
  return CANVAS_COLORS.includes(value as CanvasColor)
}

function isCardSound(value: unknown, turns: Turn[]): value is CanvasCard {
  if (typeof value !== 'object' || value === null) return false
  const card = value as Partial<CanvasMessageCard> &
    Partial<CanvasExpansionCard> &
    Partial<CanvasNoteCard>
  if (typeof card.id !== 'string' || !isRect(card.rect)) return false
  const hasTurn = (id: unknown): boolean => turns.some((turn) => turn.id === id)
  if (card.kind === 'note') return typeof card.text === 'string'
  if (card.kind === 'message') return hasTurn(card.userTurnId) && hasTurn(card.turnId)
  return (
    card.kind === 'expansion' &&
    typeof card.hostId === 'string' &&
    typeof card.expansionId === 'number' &&
    findExpansionInTurns(turns, card.expansionId)?.turn.id === card.turnId
  )
}

function dropOrphans(cards: CanvasCard[]): CanvasCard[] {
  const ids = new Set(cards.map((card) => card.id))
  const kept = cards.filter((card) => card.kind !== 'expansion' || ids.has(card.hostId))
  return kept.length === cards.length ? cards : dropOrphans(kept)
}

/** The same card with its optional fields made sound; the same object when they already are. */
function soundCard(card: CanvasCard, ids: ReadonlySet<string>): CanvasCard {
  let next = card
  if (card.color !== undefined && !isColor(card.color)) next = withoutField(next, 'color')
  if (next.kind === 'note') return next
  const collapsedFrom = next.collapsedFrom
  if (collapsedFrom !== undefined && !(Number.isFinite(collapsedFrom) && collapsedFrom > 0)) {
    next = withoutField(next, 'collapsedFrom')
  }
  // Older canvases marked an expansion drawn inside its host; that no longer means anything.
  if (next.kind === 'expansion' && 'inset' in next) {
    next = withoutField(next as CanvasExpansionCard & { inset?: unknown }, 'inset')
  }
  if (next.kind !== 'message') return next
  // The session it continued is gone; it stands on its own now.
  if (next.parentId !== undefined && !ids.has(next.parentId)) {
    next = withoutField(next, 'parentId')
  }
  const sources = next.sources
  if (sources === undefined) return next
  const known = Array.isArray(sources) ? sources.filter((id) => ids.has(id)) : []
  if (known.length === 0) return withoutField(next, 'sources')
  return known.length === sources.length ? next : { ...next, sources: known }
}

function soundFrames(raw: unknown): CanvasFrame[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((value): CanvasFrame[] => {
    const frame = value as Partial<CanvasFrame> | null
    if (typeof frame?.id !== 'string' || !isRect(frame.rect)) return []
    return [
      {
        id: frame.id,
        rect: frame.rect,
        title: typeof frame.title === 'string' ? frame.title : '',
        ...(isColor(frame.color) ? { color: frame.color } : {})
      }
    ]
  })
}

function soundLinks(raw: unknown, ids: ReadonlySet<string>): CanvasLink[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((value): CanvasLink[] => {
    const link = value as Partial<CanvasLink> | null
    if (typeof link?.id !== 'string' || typeof link.from !== 'string') return []
    if (typeof link.to !== 'string' || link.from === link.to) return []
    if (!ids.has(link.from) || !ids.has(link.to)) return []
    return [
      {
        id: link.id,
        from: link.from,
        to: link.to,
        ...(typeof link.label === 'string' && link.label !== '' ? { label: link.label } : {}),
        ...(link.context === 'card' || link.context === 'branch' ? { context: link.context } : {})
      }
    ]
  })
}

function soundStack(raw: unknown, ids: ReadonlySet<string>): string[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw)].filter((id): id is string => ids.has(id as string))
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
    cards: cards.map((card) => soundCard(card, ids)),
    frames: soundFrames(value.frames),
    links: soundLinks(value.links, ids),
    stack: soundStack(value.stack, ids),
    viewport: viewportOk
      ? {
          x: viewport!.x,
          y: viewport!.y,
          zoom: Math.min(Math.max(viewport!.zoom, MIN_ZOOM), MAX_ZOOM)
        }
      : DEFAULT_VIEWPORT
  }
}
