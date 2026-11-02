import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  CanvasCard,
  CanvasPoint,
  CanvasRect,
  CanvasSide,
  CanvasViewport,
  SnapResult
} from '../../../../shared/canvas'
import {
  CLICK_DRAG_LIMIT,
  DEFAULT_EXPANSION_SIZE,
  DEFAULT_MESSAGE_SIZE,
  MIN_EXPANSION_SIZE,
  MIN_MESSAGE_SIZE,
  adjacentSlot,
  cascadeCardIds,
  clampPointInside,
  clampRectInside,
  containsPoint,
  containsRect,
  continuationCandidates,
  estimateWords,
  fitViewport,
  fitsOnScreen,
  gridSpacing,
  isTopLevel,
  movingCardIds,
  pulledOutCardIds,
  nearestCardInDirection,
  rectAgainst,
  rectCenteredAt,
  rectClearBelow,
  rectClearOf,
  rectFromPoints,
  rectsOverlap,
  resizeCard,
  resizeFollowerIds,
  resolveMove,
  revealRect,
  screenToWorld,
  snapEdges,
  snapMove,
  sourceCardId,
  topLevelRects,
  unionRect,
  visibleWorldRect,
  wheelZoomFactor,
  zoomAt
} from '../../../../shared/canvas'
import type { ExpansionNode, ExpansionTarget } from '../../../../shared/rich-text'
import { findExpansionInTurns, flattenMarkdown } from '../../../../shared/rich-text'
import ContextMenu from '../../components/conversation/ContextMenu'
import type { ContextMenuState } from '../../components/conversation/ContextMenu'
import ExpandPrompt from '../../components/conversation/ExpandPrompt'
import ExpandSelectionBar from '../../components/conversation/ExpandSelectionBar'
import type { useCanvas } from '../../hooks/useCanvas'
import { useExpansionContextMenu } from '../../hooks/useExpansionContextMenu'
import { formatRelativeTime } from '../../lib/format'
import type { ViewportMotion } from '../../lib/viewport-motion'
import { createViewportMotion } from '../../lib/viewport-motion'
import CanvasCardView from './CanvasCardView'
import type { CanvasCardActions, CanvasCardStatus } from './CanvasCardView'
import CanvasDraft from './CanvasDraft'
import CanvasLinks from './CanvasLinks'
import CanvasShortcuts from './CanvasShortcuts'

type Canvas = ReturnType<typeof useCanvas>
type Tool = 'move' | 'select'

type Gesture =
  | { type: 'pan'; pointer: CanvasPoint; origin: CanvasViewport }
  | { type: 'draw'; start: CanvasPoint; end: CanvasPoint }
  | {
      type: 'drag'
      id: string
      ids: Set<string>
      /** Alt+drag: only this card moves, and it snaps to nothing. */
      pulledOut: boolean
      start: CanvasPoint
      pointer: CanvasPoint
    }
  | { type: 'resize'; id: string; start: CanvasPoint; pointer: CanvasPoint }

/** A rectangle waiting for its question: the canvas's composer. */
interface Draft {
  /** A fresh draft is a fresh composer, so typed text never carries over. */
  key: number
  /** Where it stands, or only its size when it is kept against `side` of its parent. */
  rect: CanvasRect
  parentId?: string
  /** Kept against this side of its parent, so the parent growing or moving carries it along. */
  side?: CanvasSide
  /** The cards it could continue, newest first; the user picks one in the draft. */
  sessions: string[]
}

/** A chosen expansion waiting for the rectangle that decides its size. */
interface Placing {
  turnId: number
  target: ExpansionTarget
  prompt?: string
  hostId: string
  label: string
}

interface DrawOutcome {
  rect: CanvasRect
  guidesX: number[]
  guidesY: number[]
  /** Why this rectangle cannot be used; null when it can. */
  refusal: string | null
  inset: boolean
}

const SNAP_SCREEN_PX = 10
const VIEWPORT_TRANSITION_MS = 360
const PULSE_MS = 900
const NOTICE_MS = 4000
const ZOOM_STEP = 1.25
const EXPORT_SAVED_MS = 2000

const REFUSE_TOO_SMALL = 'That rectangle is too small to hold an answer. Draw a larger one.'
const REFUSE_OVERLAP =
  'Rectangles cannot overlap. Draw in open space, or against a side to continue a session.'
const REFUSE_IN_MESSAGE =
  'To draw inside a message, select some text in it and choose Expand first.'
const REFUSE_MOVE = 'There is something in the way, so the card went back.'
const NO_ROOM = 'There is no room on that side. Draw the next rectangle by hand.'
const NO_CONTINUE_INSET = 'Drag this expansion clear of its message to continue it.'
const NO_CONTINUE_FAILED = 'Retry this answer before continuing it.'
const WAITING_PARENT = 'Waiting for the answer it continues…'
const FAILED_PARENT = 'The answer it continues failed. Retry it first.'

/** How far an arrow key pans, in screen pixels; Shift pans further. */
const PAN_STEP = 80
const PAN_STEP_LARGE = 320
/** Space kept around a new session opened from the keyboard. */
const NEW_SESSION_GAP = 48
/** How much of the plane around a term is brought on screen when returning to it. */
const TERM_REVEAL = { w: 360, h: 220 }

const ARROW_SIDES: Readonly<Record<string, CanvasSide>> = {
  ArrowRight: 'right',
  ArrowLeft: 'left',
  ArrowDown: 'bottom',
  ArrowUp: 'top'
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

/** Keys on these belong to them: Enter presses a button, arrows move a caret or scroll text. */
function ownsKeys(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      'button, a, select, [role="button"], [data-canvas-card], [data-canvas-draft]'
    ) !== null
  )
}

function canScrollBy(element: Element, dx: number, dy: number): boolean {
  const { scrollTop, scrollHeight, clientHeight, scrollLeft, scrollWidth, clientWidth } = element
  if (dy < 0 && scrollTop > 0) return true
  if (dy > 0 && scrollTop + clientHeight < scrollHeight - 1) return true
  if (dx < 0 && scrollLeft > 0) return true
  return dx > 0 && scrollLeft + clientWidth < scrollWidth - 1
}

/** Chromium leaves Shift+wheel vertical here, and it is a plain mouse's only way sideways. */
function wheelPanDelta(e: WheelEvent): { deltaX: number; deltaY: number } {
  if (e.shiftKey && e.deltaX === 0) return { deltaX: e.deltaY, deltaY: 0 }
  return { deltaX: e.deltaX, deltaY: e.deltaY }
}

/** A claimed press takes no focus by itself, so whatever held it would otherwise keep it. */
function releaseFocus(pressed: Element): void {
  const active = document.activeElement
  if (active instanceof HTMLElement && !active.contains(pressed)) active.blur()
}

/** The height a card needs for its answer at its current width, in world pixels. */
function measureCardHeight(surface: HTMLElement, id: string): number | null {
  const card = surface.querySelector<HTMLElement>(`[data-canvas-card="${id}"] .canvas-card-surface`)
  const body = card?.querySelector<HTMLElement>('.canvas-card-body')
  const content = body?.querySelector<HTMLElement>('.message-content')
  if (!card || !body || !content) return null
  // Without this, the scrollbar of an overflowing answer narrows the text being measured.
  const overflowY = body.style.overflowY
  body.style.overflowY = 'hidden'
  const { paddingTop, paddingBottom } = getComputedStyle(body)
  const height =
    card.offsetHeight -
    body.clientHeight +
    parseFloat(paddingTop) +
    parseFloat(paddingBottom) +
    content.offsetHeight
  body.style.overflowY = overflowY
  return height
}

/** Scrolls a card body so `el` sits in its middle, without moving anything around it. */
function scrollIntoBody(el: Element, scale: number): void {
  const body = el.closest<HTMLElement>('.canvas-card-body')
  if (!body) return
  const offset =
    (el.getBoundingClientRect().top - body.getBoundingClientRect().top) / scale + body.scrollTop
  body.scrollTop = offset - body.clientHeight / 2
}

function dependentsPhrase(count: number): string {
  return count === 1 ? 'the card that depends on it' : `the ${count} cards that depend on it`
}

/** Taking other cards along is asked about twice, as they may be far off screen. */
function confirmCascade(question: string, dependents: number): boolean {
  return (
    window.confirm(question) &&
    window.confirm(
      `Are you sure? ${dependents === 1 ? '1 other card' : `${dependents} other cards`} will be permanently deleted. This cannot be undone.`
    )
  )
}

/** Keeps a run of wheel events on what it started moving as things pass under the pointer. */
const WHEEL_LATCH_MS = 160

/** Reads the status a card should show from its turn or expansion. */
function cardContent(
  card: CanvasCard,
  canvas: Canvas
): {
  caption: string
  question?: string
  answer: string
  expansions: ExpansionNode[]
  status: CanvasCardStatus
  failure?: string
} {
  if (card.kind === 'message') {
    const user = canvas.turns.find((turn) => turn.id === card.userTurnId)
    const turn = canvas.turns.find((item) => item.id === card.turnId)
    const content = turn?.content ?? ''
    const streaming = canvas.streamingTurnIds.has(card.turnId)
    const blank = content.trim() === ''
    const failed = !streaming && (turn?.error === true || blank)
    return {
      caption: user?.content ?? '',
      answer: content,
      expansions: turn?.expansions ?? [],
      status: streaming ? 'streaming' : failed ? 'failed' : 'done',
      ...(failed ? { failure: blank ? 'Stopped before an answer.' : content } : {})
    }
  }
  const node = findExpansionInTurns(canvas.turns, card.expansionId)?.node
  return {
    caption: flattenMarkdown(node?.originalText ?? ''),
    ...(node?.prompt?.trim() ? { question: node.prompt.trim() } : {}),
    answer: node?.answer ?? '',
    expansions: node?.children ?? [],
    status: node?.status === 'loading' ? 'streaming' : node?.status === 'error' ? 'failed' : 'done',
    ...(node?.status === 'error' ? { failure: node.error ?? 'The answer failed.' } : {})
  }
}

function CanvasBoard({ canvas }: { canvas: Canvas }): React.JSX.Element {
  const { cards, viewport, turns, setViewport, updateCards } = canvas
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [tool, setTool] = useState<Tool>(cards.length === 0 ? 'select' : 'move')
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [placing, setPlacing] = useState<Placing | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pulseId, setPulseId] = useState<string | null>(null)
  const [animating, setAnimating] = useState(false)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [listMenu, setListMenu] = useState<ContextMenuState | null>(null)
  const [exportState, setExportState] = useState<'idle' | 'exporting' | 'saved'>('idle')
  const [helpOpen, setHelpOpen] = useState(false)
  const [pulseTerm, setPulseTerm] = useState<{ cardId: string; expansionId: number } | null>(null)
  const [surfaceBox, setSurfaceBox] = useState({ width: 0, height: 0 })
  const noticeTimerRef = useRef<number | null>(null)
  const pulseTimerRef = useRef<number | null>(null)
  const draftKeyRef = useRef(0)
  /** The card Enter replies to when no card has focus: the last one touched or asked. */
  const currentIdRef = useRef<string | null>(null)
  /**
   * Like a chat pinned to its bottom: while true, the viewport keeps the waiting
   * draft and the answer it follows on screen. Moving the view by hand lets go.
   */
  const followRef = useRef(true)
  const animationTimerRef = useRef<number | null>(null)
  const exportTimerRef = useRef<number | null>(null)

  const worldRef = useRef<HTMLDivElement>(null)
  const zoomValueRef = useRef<HTMLSpanElement>(null)
  const motionRef = useRef<ViewportMotion | null>(null)

  const viewportRef = useRef(viewport)
  const paintViewport = useCallback((next: CanvasViewport): void => {
    viewportRef.current = next
    const { x, y, zoom } = next
    const grid = gridSpacing(zoom)
    if (worldRef.current) {
      worldRef.current.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`
    }
    if (surfaceRef.current) {
      surfaceRef.current.style.backgroundSize = `${grid}px ${grid}px`
      surfaceRef.current.style.backgroundPosition = `${x}px ${y}px`
    }
    if (zoomValueRef.current) zoomValueRef.current.textContent = `${Math.round(zoom * 100)}%`
  }, [])

  // The plane's position is never a React style prop: frames in motion are written
  // directly, and React's diff would skip a viewport equal to the one it last rendered.
  useLayoutEffect(() => {
    paintViewport(viewport)
    // Inherited by every card, so it is restyled only at rest, never frame by frame.
    worldRef.current?.style.setProperty('--canvas-zoom', String(viewport.zoom))
  }, [paintViewport, viewport])

  useEffect(() => {
    const motion = createViewportMotion({
      read: () => viewportRef.current,
      paint: paintViewport,
      commit: setViewport,
      setMoving: (moving) => surfaceRef.current?.toggleAttribute('data-moving', moving)
    })
    motionRef.current = motion
    return () => motion.cancel()
  }, [paintViewport, setViewport])

  // Callbacks read the turns through this, so card actions stay stable while text streams.
  const canvasRef = useRef(canvas)
  useEffect(() => {
    canvasRef.current = canvas
  }, [canvas])

  const unfollow = useCallback((): void => {
    followRef.current = false
  }, [])

  useEffect(() => {
    return () => {
      for (const timer of [noticeTimerRef, pulseTimerRef, animationTimerRef, exportTimerRef]) {
        if (timer.current !== null) window.clearTimeout(timer.current)
      }
    }
  }, [])

  const showNotice = useCallback((message: string): void => {
    setNotice(message)
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), NOTICE_MS)
  }, [])

  const surfaceSize = useCallback((): { width: number; height: number } => {
    const box = surfaceRef.current?.getBoundingClientRect()
    return { width: box?.width ?? 0, height: box?.height ?? 0 }
  }, [])

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const observer = new ResizeObserver(() => {
      const box = surface.getBoundingClientRect()
      setSurfaceBox((prev) =>
        prev.width === box.width && prev.height === box.height
          ? prev
          : { width: box.width, height: box.height }
      )
    })
    observer.observe(surface)
    return () => observer.disconnect()
  }, [])

  /** Eases to a viewport; panning and wheel zoom go through `motionRef` instead. */
  const glideTo = useCallback(
    (next: CanvasViewport): void => {
      motionRef.current?.settle()
      setAnimating(true)
      setViewport(next)
      if (animationTimerRef.current !== null) window.clearTimeout(animationTimerRef.current)
      animationTimerRef.current = window.setTimeout(
        () => setAnimating(false),
        VIEWPORT_TRANSITION_MS
      )
    },
    [setViewport]
  )

  const pointerOnSurface = useCallback((e: { clientX: number; clientY: number }): CanvasPoint => {
    const box = surfaceRef.current?.getBoundingClientRect()
    return { x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) }
  }, [])

  const pointerInWorld = useCallback(
    (e: { clientX: number; clientY: number }): CanvasPoint =>
      screenToWorld(viewportRef.current, pointerOnSurface(e)),
    [pointerOnSurface]
  )

  /* ---- Expansions: choose a term, then draw its size ---- */

  const cardsRef = useRef(cards)
  useEffect(() => {
    cardsRef.current = cards
  }, [cards])

  const beginPlacing = useCallback((turnId: number, target: ExpansionTarget, prompt?: string) => {
    const host = cardsRef.current.find((card) =>
      target.parentExpansionId !== undefined
        ? card.kind === 'expansion' && card.expansionId === target.parentExpansionId
        : card.kind === 'message' && card.turnId === turnId
    )
    if (!host) return { ok: false as const, reason: 'turn-not-found' }
    window.getSelection()?.removeAllRanges()
    setDraft(null)
    setPlacing({
      turnId,
      target,
      ...(prompt !== undefined ? { prompt } : {}),
      hostId: host.id,
      label: flattenMarkdown(target.selection ?? '').slice(0, 40)
    })
    return { ok: true as const }
  }, [])

  const selection = useExpansionContextMenu({
    turns,
    onExpand: beginPlacing,
    onUnfold: () => {}
  })

  /* ---- Drawing ---- */

  const drawnRect = useCallback(
    (start: CanvasPoint, end: CanvasPoint): DrawOutcome => {
      const threshold = SNAP_SCREEN_PX / viewport.zoom
      const others = topLevelRects(cards)
      const raw = rectFromPoints(start, end)
      const isClick = raw.w < CLICK_DRAG_LIMIT && raw.h < CLICK_DRAG_LIMIT
      const host = placing ? cards.find((card) => card.id === placing.hostId) : undefined

      if (placing && host && containsPoint(host.rect, start)) {
        const rect = clampRectInside(
          isClick ? rectCenteredAt(end, DEFAULT_EXPANSION_SIZE) : raw,
          host.rect
        )
        const tooSmall = rect.w < MIN_EXPANSION_SIZE.w || rect.h < MIN_EXPANSION_SIZE.h
        return {
          rect,
          guidesX: [],
          guidesY: [],
          refusal: tooSmall ? REFUSE_TOO_SMALL : null,
          inset: containsRect(host.rect, rect)
        }
      }

      const min = placing ? MIN_EXPANSION_SIZE : MIN_MESSAGE_SIZE
      const clickSize = placing ? DEFAULT_EXPANSION_SIZE : DEFAULT_MESSAGE_SIZE
      const snapped: SnapResult = snapEdges(
        isClick ? rectCenteredAt(end, clickSize) : raw,
        others,
        threshold
      )
      const overlaps = others.some((rect) => rectsOverlap(snapped.rect, rect))
      const startedInCard = others.some((rect) => containsPoint(rect, start))
      const refusal =
        snapped.rect.w < min.w || snapped.rect.h < min.h
          ? REFUSE_TOO_SMALL
          : overlaps
            ? !placing && startedInCard
              ? REFUSE_IN_MESSAGE
              : REFUSE_OVERLAP
            : null
      return { ...snapped, refusal, inset: false }
    },
    [cards, placing, viewport.zoom]
  )

  const finishDraw = useCallback(
    (start: CanvasPoint, end: CanvasPoint): void => {
      const outcome = drawnRect(start, end)
      if (outcome.refusal) {
        showNotice(outcome.refusal)
        return
      }
      if (placing) {
        const result = canvas.expand(placing.turnId, placing.target, placing.prompt, {
          hostId: placing.hostId,
          rect: outcome.rect,
          inset: outcome.inset
        })
        if (!result.ok) showNotice('That selection is no longer available. Select it again.')
        setPlacing(null)
        setTool('move')
        return
      }
      const sessions = continuationCandidates(outcome.rect, cards).map((card) => card.id)
      followRef.current = true
      setDraft({
        key: ++draftKeyRef.current,
        rect: outcome.rect,
        ...(sessions.length > 0 ? { parentId: sessions[0] } : {}),
        sessions
      })
      setTool('move')
    },
    [canvas, cards, drawnRect, placing, showNotice]
  )

  /* ---- Pointer gestures ---- */

  /*
   * A gesture owns its press from here. It cannot cancel pointerdown for that: doing so
   * also suppresses mousedown, which is how open menus and prompts notice an outside click.
   */
  const claimedPressRef = useRef(false)
  const claimPress = useCallback((e: React.PointerEvent): void => {
    claimedPressRef.current = true
    motionRef.current?.settle()
    surfaceRef.current?.setPointerCapture(e.pointerId)
  }, [])

  // Stops text selection and middle-click autoscroll. Runs after a closing menu has
  // handed focus back, so that focus is released too.
  const handleSurfaceMouseDown = (e: React.MouseEvent): void => {
    if (!claimedPressRef.current) return
    claimedPressRef.current = false
    e.preventDefault()
    releaseFocus(e.target as Element)
  }

  const handleSurfaceDown = (e: React.PointerEvent): void => {
    const target = e.target as Element
    const startPan = e.button === 1 || (e.button === 0 && spaceHeld)
    const drawing = tool === 'select' || placing !== null
    if (!startPan && !drawing && target.closest('.canvas-link-hit')) return
    if (startPan || (e.button === 0 && !drawing && !target.closest('.canvas-card'))) {
      window.getSelection()?.removeAllRanges()
      claimPress(e)
      unfollow()
      setGesture({ type: 'pan', pointer: pointerOnSurface(e), origin: viewportRef.current })
      return
    }
    if (e.button === 0 && drawing) {
      const start = pointerInWorld(e)
      claimPress(e)
      setGesture({ type: 'draw', start, end: start })
    }
  }

  const handleSurfaceMove = (e: React.PointerEvent): void => {
    if (!gesture) return
    if (gesture.type === 'pan') {
      const pointer = pointerOnSurface(e)
      const next = {
        ...gesture.origin,
        x: gesture.origin.x + pointer.x - gesture.pointer.x,
        y: gesture.origin.y + pointer.y - gesture.pointer.y
      }
      motionRef.current?.steer(() => next, true)
    } else if (gesture.type === 'draw') {
      setGesture({ ...gesture, end: pointerInWorld(e) })
    } else {
      setGesture({ ...gesture, pointer: pointerInWorld(e) })
    }
  }

  const dragDelta = useMemo((): {
    dx: number
    dy: number
    guidesX: number[]
    guidesY: number[]
  } => {
    const still = { dx: 0, dy: 0, guidesX: [], guidesY: [] }
    if (gesture?.type !== 'drag') return still
    const card = cards.find((item) => item.id === gesture.id)
    if (!card) return still
    const moved = {
      ...card.rect,
      x: card.rect.x + gesture.pointer.x - gesture.start.x,
      y: card.rect.y + gesture.pointer.y - gesture.start.y
    }
    const snapDistance = gesture.pulledOut ? -1 : SNAP_SCREEN_PX / viewport.zoom
    const snap = snapMove(moved, topLevelRects(cards, gesture.ids), snapDistance)
    return {
      dx: snap.rect.x - card.rect.x,
      dy: snap.rect.y - card.rect.y,
      guidesX: snap.guidesX,
      guidesY: snap.guidesY
    }
  }, [cards, gesture, viewport.zoom])

  const resizedRect = useMemo((): CanvasRect | null => {
    if (gesture?.type !== 'resize') return null
    const card = cards.find((item) => item.id === gesture.id)
    if (!card) return null
    const min = card.kind === 'message' ? MIN_MESSAGE_SIZE : MIN_EXPANSION_SIZE
    const rect = {
      ...card.rect,
      w: Math.max(card.rect.w + gesture.pointer.x - gesture.start.x, min.w),
      h: Math.max(card.rect.h + gesture.pointer.y - gesture.start.y, min.h)
    }
    if (card.kind === 'expansion' && card.inset) {
      const host = cards.find((item) => item.id === card.hostId)
      return host ? clampRectInside(rect, host.rect) : rect
    }
    // A card that follows the moving edge is not a target: it would hold the edge in place.
    const carried = new Set([card.id, ...resizeFollowerIds(cards, card.id)])
    const snapped = snapEdges(
      rect,
      topLevelRects(cards, carried),
      SNAP_SCREEN_PX / viewport.zoom
    ).rect
    return { ...rect, w: snapped.x + snapped.w - rect.x, h: snapped.y + snapped.h - rect.y }
  }, [cards, gesture, viewport.zoom])

  const dragResult = useMemo(
    () =>
      gesture?.type === 'drag'
        ? resolveMove(cards, gesture.id, gesture.ids, dragDelta.dx, dragDelta.dy)
        : null,
    [cards, dragDelta, gesture]
  )

  const resizeUpdates = useMemo(
    () =>
      gesture?.type === 'resize' && resizedRect
        ? resizeCard(cards, gesture.id, { w: resizedRect.w, h: resizedRect.h })
        : null,
    [cards, gesture, resizedRect]
  )
  const resizeBlocked = gesture?.type === 'resize' && resizedRect !== null && !resizeUpdates

  // A refused drop or resize sends back everything that would have moved, so all of it warns.
  const refusedIds = useMemo((): ReadonlySet<string> => {
    if (gesture?.type === 'drag') return dragResult?.ok === false ? gesture.ids : new Set()
    if (gesture?.type === 'resize' && resizeBlocked) {
      return new Set([gesture.id, ...resizeFollowerIds(cards, gesture.id)])
    }
    return new Set()
  }, [cards, dragResult, gesture, resizeBlocked])

  const handleSurfaceUp = (): void => {
    claimedPressRef.current = false
    if (!gesture) return
    setGesture(null)
    if (gesture.type === 'draw') {
      finishDraw(gesture.start, gesture.end)
    } else if (gesture.type === 'drag') {
      if (dragDelta.dx === 0 && dragDelta.dy === 0) return
      if (!dragResult?.ok) {
        showNotice(REFUSE_MOVE)
        return
      }
      updateCards(dragResult.updates)
      // Inside its host the answer may have been cut short; out here it has room.
      const wasInset = cards.some((card) => card.id === gesture.id && !isTopLevel(card))
      const isOut = dragResult.updates.some((item) => item.id === gesture.id && !item.inset)
      if (wasInset && isOut) canvas.requestFit(gesture.id)
    } else if (gesture.type === 'resize' && resizedRect) {
      if (resizeUpdates) updateCards(resizeUpdates)
      else showNotice(REFUSE_MOVE)
    }
  }

  const handleDragStart = useCallback<CanvasCardActions['onDragStart']>(
    (e, id) => {
      if (e.button !== 0 || (e.target as Element).closest('button')) return
      const start = pointerInWorld(e)
      claimPress(e)
      currentIdRef.current = id
      setGesture({
        type: 'drag',
        id,
        ids: e.altKey
          ? pulledOutCardIds(cardsRef.current, id)
          : movingCardIds(cardsRef.current, id),
        pulledOut: e.altKey,
        start,
        pointer: start
      })
    },
    [claimPress, pointerInWorld]
  )

  const handleResizeStart = useCallback<CanvasCardActions['onResizeStart']>(
    (e, id) => {
      if (e.button !== 0) return
      const start = pointerInWorld(e)
      claimPress(e)
      setGesture({ type: 'resize', id, start, pointer: start })
    },
    [claimPress, pointerInWorld]
  )

  /* ---- Wheel: pan, or zoom with Ctrl/pinch; a card with more text scrolls first ---- */

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    let latch: { target: Element | 'plane'; at: number } | null = null
    const handleWheel = (e: WheelEvent): void => {
      const held = latch && e.timeStamp - latch.at < WHEEL_LATCH_MS ? latch.target : null
      const { deltaX, deltaY } = wheelPanDelta(e)
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        followRef.current = false
        latch = { target: 'plane', at: e.timeStamp }
        const box = surface.getBoundingClientRect()
        const anchor = { x: e.clientX - box.left, y: e.clientY - box.top }
        const factor = wheelZoomFactor(e.deltaY)
        motionRef.current?.steer((view) => zoomAt(view, anchor, view.zoom * factor))
        return
      }
      if (held instanceof Element) {
        // A card scrolled to its end stops there rather than dragging the plane after it.
        latch = { target: held, at: e.timeStamp }
        if (!canScrollBy(held, deltaX, deltaY)) e.preventDefault()
        return
      }
      const body = held ? null : (e.target as Element).closest('.canvas-card-body')
      if (body && canScrollBy(body, deltaX, deltaY)) {
        latch = { target: body, at: e.timeStamp }
        return
      }
      e.preventDefault()
      followRef.current = false
      latch = { target: 'plane', at: e.timeStamp }
      motionRef.current?.steer((view) => ({ ...view, x: view.x - deltaX, y: view.y - deltaY }))
    }
    surface.addEventListener('wheel', handleWheel, { passive: false })
    return () => surface.removeEventListener('wheel', handleWheel)
  }, [])

  /* ---- Fitting heights to finished answers ---- */

  const { fitCardIds, fitCard } = canvas

  // Before paint, so the card eases to its height from the frame the text settled in.
  useLayoutEffect(() => {
    const surface = surfaceRef.current
    if (!surface || gesture || fitCardIds.size === 0) return
    for (const id of fitCardIds) {
      fitCard(id, measureCardHeight(surface, id))
    }
  }, [fitCard, fitCardIds, gesture])

  /* ---- Card actions ---- */

  const { stopCard, regenerateCard, editCard, deleteCard, exportCanvas } = canvas
  const { askAnotherExpansion } = selection

  const handleDelete = useCallback(
    (id: string): void => {
      const dependents = cascadeCardIds(cardsRef.current, id).size - 1
      const confirmed =
        dependents === 0 ||
        confirmCascade(`Delete this card and ${dependentsPhrase(dependents)}?`, dependents)
      if (confirmed) deleteCard(id)
    },
    [deleteCard]
  )

  const confirmReplacing = useCallback((id: string): boolean => {
    const dependents = cascadeCardIds(cardsRef.current, id).size - 1
    if (dependents === 0) return true
    return confirmCascade(
      `This replaces the answer and removes ${dependentsPhrase(dependents)}. Continue?`,
      dependents
    )
  }, [])

  const handleRegenerate = useCallback(
    (id: string): void => {
      if (confirmReplacing(id)) regenerateCard(id)
    },
    [confirmReplacing, regenerateCard]
  )

  const handleEdit = useCallback(
    (id: string, question: string): boolean => {
      if (!confirmReplacing(id)) return false
      editCard(id, question)
      return true
    },
    [confirmReplacing, editCard]
  )

  const handleExport = async (): Promise<void> => {
    if (exportState === 'exporting') return
    if (exportTimerRef.current !== null) window.clearTimeout(exportTimerRef.current)
    setExportState('exporting')
    try {
      const result = await exportCanvas()
      if (result.ok) {
        setExportState('saved')
        exportTimerRef.current = window.setTimeout(() => setExportState('idle'), EXPORT_SAVED_MS)
        return
      }
      if (result.error !== 'Canceled.') showNotice(result.error)
    } catch (err) {
      showNotice(err instanceof Error ? err.message : String(err))
    }
    setExportState('idle')
  }

  /* ---- Moving between cards ---- */

  /** The smallest glide that brings a rectangle on screen; none when it already is. */
  const revealOnScreen = useCallback(
    (rect: CanvasRect): void => {
      const next = revealRect(viewportRef.current, rect, surfaceSize())
      if (next.x !== viewportRef.current.x || next.y !== viewportRef.current.y) glideTo(next)
    },
    [glideTo, surfaceSize]
  )

  /** Flashes a card, or one expanded term inside it. */
  const flash = useCallback((cardId: string, expansionId?: number): void => {
    setPulseId(expansionId === undefined ? cardId : null)
    setPulseTerm(expansionId === undefined ? null : { cardId, expansionId })
    if (pulseTimerRef.current !== null) window.clearTimeout(pulseTimerRef.current)
    pulseTimerRef.current = window.setTimeout(() => {
      setPulseId(null)
      setPulseTerm(null)
    }, PULSE_MS)
  }, [])

  /** Every keyboard and link jump lands here: the card gets focus and comes on screen. */
  const focusCard = useCallback(
    (id: string, pulse = false): void => {
      const card = cardsRef.current.find((item) => item.id === id)
      if (!card) return
      unfollow()
      currentIdRef.current = id
      revealOnScreen(card.rect)
      surfaceRef.current
        ?.querySelector<HTMLElement>(`[data-canvas-card="${id}"]`)
        ?.focus({ preventScroll: true })
      if (pulse) flash(id)
    },
    [flash, revealOnScreen, unfollow]
  )

  /** From an expansion back to the term it explains, scrolled into its card and flashed. */
  const returnToTerm = useCallback(
    (id: string): void => {
      const card = cardsRef.current.find((item) => item.id === id)
      if (card?.kind !== 'expansion') return
      const host = cardsRef.current.find((item) => item.id === card.hostId)
      const hostEl = surfaceRef.current?.querySelector<HTMLElement>(
        `[data-canvas-card="${card.hostId}"] .canvas-card-surface`
      )
      const term = hostEl?.querySelector<HTMLElement>(`[data-canvas-terms~="${card.expansionId}"]`)
      if (!host || !hostEl || !term) {
        focusCard(card.hostId, true)
        return
      }
      unfollow()
      const scale = hostEl.getBoundingClientRect().width / host.rect.w
      scrollIntoBody(term, scale)
      const hostBox = hostEl.getBoundingClientRect()
      const termBox = term.getBoundingClientRect()
      const center = {
        x: host.rect.x + (termBox.left + termBox.width / 2 - hostBox.left) / scale,
        y: host.rect.y + (termBox.top + termBox.height / 2 - hostBox.top) / scale
      }
      revealOnScreen(rectCenteredAt(center, TERM_REVEAL))
      currentIdRef.current = host.id
      term.focus({ preventScroll: true })
      flash(host.id, card.expansionId)
    },
    [flash, focusCard, revealOnScreen, unfollow]
  )

  const goToSource = useCallback(
    (id: string): void => {
      const card = cardsRef.current.find((item) => item.id === id)
      if (!card) return
      if (card.kind === 'expansion') {
        returnToTerm(id)
        return
      }
      const source = sourceCardId(card)
      if (source !== undefined) focusCard(source, true)
    },
    [focusCard, returnToTerm]
  )

  const handleOpenExpansion = useCallback(
    (expansionId: number): void => {
      const card = cardsRef.current.find(
        (item) => item.kind === 'expansion' && item.expansionId === expansionId
      )
      if (card) focusCard(card.id, true)
    },
    [focusCard]
  )

  /** A link click travels to whichever end is farther from where it was clicked. */
  const handleFollowLink = useCallback(
    (e: React.MouseEvent, id: string, start: CanvasPoint): void => {
      const card = cardsRef.current.find((item) => item.id === id)
      if (!card) return
      const at = pointerInWorld(e)
      const onCard = clampPointInside(at, card.rect)
      const toCard = Math.hypot(at.x - onCard.x, at.y - onCard.y)
      const toStart = Math.hypot(at.x - start.x, at.y - start.y)
      if (toStart < toCard) focusCard(id, true)
      else goToSource(id)
    },
    [focusCard, goToSource, pointerInWorld]
  )

  /* ---- The composer: drafts, and the conversation they follow ---- */

  const openDraft = useCallback((next: Omit<Draft, 'key'>): void => {
    followRef.current = true
    setPlacing(null)
    setTool('move')
    setDraft({ ...next, key: ++draftKeyRef.current })
  }, [])

  /** A draft against the first free side of `sides`, sized like the card it continues. */
  const continueCard = useCallback(
    (id: string, sides: CanvasSide[]): void => {
      const card = cardsRef.current.find((item) => item.id === id)
      if (!card) return
      if (!isTopLevel(card)) {
        showNotice(NO_CONTINUE_INSET)
        return
      }
      if (cardContent(card, canvasRef.current).status === 'failed') {
        showNotice(NO_CONTINUE_FAILED)
        return
      }
      const side = sides.find((item) => adjacentSlot(card, item, cardsRef.current) !== null)
      if (side === undefined) {
        showNotice(NO_ROOM)
        return
      }
      currentIdRef.current = id
      openDraft({ rect: card.rect, parentId: id, side, sessions: [id] })
    },
    [openDraft, showNotice]
  )

  const handleContinue = useCallback(
    (id: string, side: CanvasSide): void => continueCard(id, [side]),
    [continueCard]
  )

  /** A new session in open space near the middle of the screen. */
  const newSession = useCallback((): void => {
    const size = surfaceSize()
    const center = screenToWorld(viewportRef.current, { x: size.width / 2, y: size.height / 2 })
    const rect = rectClearOf(
      rectCenteredAt(center, DEFAULT_MESSAGE_SIZE),
      topLevelRects(cardsRef.current),
      NEW_SESSION_GAP
    )
    openDraft({ rect, sessions: [] })
  }, [openDraft, surfaceSize])

  const followRectRef = useRef<CanvasRect | null>(null)

  /** Pins the view to the composer again and brings it on screen. */
  const refollow = useCallback((): void => {
    followRef.current = true
    if (followRectRef.current) revealOnScreen(followRectRef.current)
  }, [revealOnScreen])

  /** Enter with no card focused: the composer if one is open, else a reply to the current card. */
  const compose = useCallback((): void => {
    const input = surfaceRef.current?.querySelector<HTMLTextAreaElement>(
      '[data-canvas-draft] textarea'
    )
    if (input) {
      refollow()
      input.focus({ preventScroll: true })
      return
    }
    const all = cardsRef.current
    const current =
      all.find((card) => card.id === currentIdRef.current && isTopLevel(card)) ??
      all.findLast((card) => card.kind === 'message')
    if (current) continueCard(current.id, ['bottom', 'right'])
    else newSession()
  }, [continueCard, newSession, refollow])

  const zoomBy = useCallback(
    (factor: number): void => {
      const { width, height } = surfaceSize()
      const current = viewportRef.current
      unfollow()
      glideTo(zoomAt(current, { x: width / 2, y: height / 2 }, current.zoom * factor))
    },
    [glideTo, surfaceSize, unfollow]
  )

  const showEverything = useCallback((): void => {
    unfollow()
    glideTo(
      fitViewport(
        cardsRef.current.map((card) => card.rect),
        surfaceSize()
      )
    )
  }, [glideTo, surfaceSize, unfollow])

  /* ---- Keyboard ---- */

  const handleCardKeyDown = useCallback(
    (e: React.KeyboardEvent, id: string): void => {
      const side = ARROW_SIDES[e.key]
      if (side) {
        e.preventDefault()
        const next = nearestCardInDirection(cardsRef.current, id, side)
        if (next) focusCard(next.id)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        continueCard(id, e.shiftKey ? ['right'] : ['bottom', 'right'])
      } else if (e.key === 'b' || e.key === 'B') {
        e.preventDefault()
        goToSource(id)
      } else if (e.key === 'Delete') {
        e.preventDefault()
        handleDelete(id)
      }
    },
    [continueCard, focusCard, goToSource, handleDelete]
  )

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'Escape') {
        if (gesture) setGesture(null)
        else if (helpOpen) setHelpOpen(false)
        else if (placing) setPlacing(null)
        else if (draft) setDraft(null)
        else if (tool === 'select') setTool('move')
        return
      }
      if (isTyping(e.target)) return
      const side = ARROW_SIDES[e.key]
      if (e.key === ' ') {
        // Space still presses whatever button has focus.
        if ((e.target as Element).closest?.('button, [role="button"]')) return
        e.preventDefault()
        setSpaceHeld(true)
      } else if (e.key === '?') {
        e.preventDefault()
        setHelpOpen((open) => !open)
      } else if (e.key === 'r' || e.key === 'R') {
        setTool('select')
      } else if (e.key === 'v' || e.key === 'V') {
        setTool('move')
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        newSession()
      } else if (e.key === '+' || e.key === '=') {
        zoomBy(ZOOM_STEP)
      } else if (e.key === '-') {
        zoomBy(1 / ZOOM_STEP)
      } else if (e.key === '0') {
        showEverything()
      } else if (ownsKeys(e.target)) {
        return
      } else if (e.key === 'Enter') {
        e.preventDefault()
        compose()
      } else if (side) {
        e.preventDefault()
        unfollow()
        const step = e.shiftKey ? PAN_STEP_LARGE : PAN_STEP
        const current = viewportRef.current
        const dx = side === 'left' ? step : side === 'right' ? -step : 0
        const dy = side === 'top' ? step : side === 'bottom' ? -step : 0
        glideTo({ ...current, x: current.x + dx, y: current.y + dy })
      }
    }
    const handleKeyUp = (e: KeyboardEvent): void => {
      if (e.key === ' ') setSpaceHeld(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [
    compose,
    draft,
    gesture,
    glideTo,
    helpOpen,
    newSession,
    placing,
    showEverything,
    tool,
    unfollow,
    zoomBy
  ])

  /* ---- Focus never scrolls the plane ---- */

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    // Focus scrolls the nearest clipped ancestor, but only the viewport may move the plane.
    const handleScroll = (): void => {
      if (surface.scrollTop !== 0) surface.scrollTop = 0
      if (surface.scrollLeft !== 0) surface.scrollLeft = 0
    }
    // Tabbing to a card off screen brings it on screen; a click lands where it already is.
    const handleFocusIn = (e: FocusEvent): void => {
      const target = e.target as HTMLElement
      const cardEl = target.closest<HTMLElement>('[data-canvas-card]')
      if (!cardEl) return
      const card = cardsRef.current.find((item) => item.id === cardEl.dataset.canvasCard)
      if (!card) return
      currentIdRef.current = card.id
      if (!target.matches(':focus-visible')) return
      followRef.current = false
      revealOnScreen(card.rect)
    }
    surface.addEventListener('scroll', handleScroll)
    surface.addEventListener('focusin', handleFocusIn)
    return () => {
      surface.removeEventListener('scroll', handleScroll)
      surface.removeEventListener('focusin', handleFocusIn)
    }
  }, [revealOnScreen])

  const openCanvasMenu = (e: React.MouseEvent): void => {
    const box = e.currentTarget.getBoundingClientRect()
    canvas.refreshCanvases()
    setListMenu({
      x: box.left,
      y: box.bottom + 6,
      items: [
        { label: 'New canvas', onSelect: canvas.newCanvas },
        ...canvas.canvases
          .filter((item) => item.id !== canvas.canvasId)
          .map((item) => ({
            label: item.title,
            detail: formatRelativeTime(item.updatedAt),
            onSelect: () => canvas.openCanvas(item.id)
          })),
        ...(cards.length > 0
          ? [
              {
                label: 'Delete this canvas',
                onSelect: () => {
                  if (window.confirm(`Delete “${canvas.title}”? This cannot be undone.`)) {
                    canvas.deleteCanvas()
                  }
                }
              }
            ]
          : [])
      ]
    })
  }

  /* ---- What is on screen ---- */

  const displayed = useMemo((): CanvasCard[] => {
    if (gesture?.type === 'drag') {
      const { dx, dy } = dragDelta
      const moved = cards.map((card) =>
        gesture.ids.has(card.id)
          ? { ...card, rect: { ...card.rect, x: card.rect.x + dx, y: card.rect.y + dy } }
          : card
      )
      // The link appears the moment the card clears its host, before the drop.
      return moved.map((card) => {
        if (card.id !== gesture.id || card.kind !== 'expansion') return card
        const host = moved.find((item) => item.id === card.hostId)
        return { ...card, inset: host ? containsRect(host.rect, card.rect) : card.inset }
      })
    }
    if (gesture?.type === 'resize' && resizedRect) {
      // Refused, the card still shows its size, and its neighbours stay where they are.
      const moved = new Map(resizeUpdates?.map((update) => [update.id, update.rect]))
      if (!resizeUpdates) moved.set(gesture.id, resizedRect)
      return cards.map((card) => {
        const rect = moved.get(card.id)
        return rect ? { ...card, rect } : card
      })
    }
    return cards
  }, [cards, dragDelta, gesture, resizedRect, resizeUpdates])

  const draftParent = useMemo(
    () =>
      draft?.parentId === undefined
        ? undefined
        : displayed.find((card) => card.id === draft.parentId),
    [displayed, draft]
  )

  // A draft kept against its parent follows it as it grows or moves; one that a card
  // grew or was dropped over moves out of the way.
  const draftRect = useMemo(() => {
    if (!draft) return null
    const base =
      draft.side && draftParent ? rectAgainst(draftParent.rect, draft.side, draft.rect) : draft.rect
    return rectClearBelow(base, topLevelRects(displayed))
  }, [displayed, draft, draftParent])

  // The answer being continued and its composer, both when they fit; else the composer,
  // with the newest lines of the answer just above it, as in a chat.
  const followRect = useMemo((): CanvasRect | null => {
    if (!draftRect) return null
    if (!draftParent) return draftRect
    const both = unionRect(draftParent.rect, draftRect)
    return fitsOnScreen(both, viewport.zoom, surfaceBox) ? both : draftRect
  }, [draftParent, draftRect, surfaceBox, viewport.zoom])

  useEffect(() => {
    followRectRef.current = followRect
    if (!followRef.current || !followRect || gesture || surfaceBox.width === 0) return
    revealOnScreen(followRect)
  }, [followRect, gesture, revealOnScreen, surfaceBox.width])

  const draftHidden =
    draftRect !== null &&
    surfaceBox.width > 0 &&
    !rectsOverlap(draftRect, visibleWorldRect(viewport, surfaceBox))

  const submitDraft = (question: string): void => {
    if (!draftRect) return
    const id = canvas.ask(draftRect, question, draftParent?.id)
    currentIdRef.current = id
    // Like a chat, the next question can be typed at once, under the answer being written.
    const obstacles = topLevelRects(cards)
    const side = (['bottom', 'right'] as const).find((item) => {
      const slot = rectAgainst(draftRect, item, draftRect)
      return !obstacles.some((rect) => rectsOverlap(slot, rect))
    })
    if (side) openDraft({ rect: draftRect, parentId: id, side, sessions: [id] })
    else setDraft(null)
  }

  const cancelDraft = (): void => {
    const parentId = draftParent?.id
    setDraft(null)
    if (parentId !== undefined) focusCard(parentId)
  }

  const changeDraftParent = (parentId: string | undefined): void => {
    if (!draft || !draftRect) return
    // Choosing another session pins the rectangle where it stands now.
    setDraft({
      key: draft.key,
      rect: draftRect,
      ...(parentId !== undefined ? { parentId } : {}),
      sessions: draft.sessions
    })
  }

  const draftSessions = (draft?.sessions ?? []).flatMap((id) => {
    const card = cards.find((item) => item.id === id)
    if (!card) return []
    const content = cardContent(card, canvas)
    return [
      { id, label: content.question ? `${content.caption}: ${content.question}` : content.caption }
    ]
  })
  const parentStatus = draftParent ? cardContent(draftParent, canvas).status : undefined

  const drawing = gesture?.type === 'draw' ? drawnRect(gesture.start, gesture.end) : null
  const drawCaption = placing?.label.length ?? 0
  const drawSessions =
    drawing && !placing && !drawing.refusal ? continuationCandidates(drawing.rect, cards) : []
  const drawParent = drawSessions.at(0)
  const continuedId = drawing ? drawParent?.id : draftParent?.id
  const activeGuides =
    gesture?.type === 'drag'
      ? { x: dragDelta.guidesX, y: dragDelta.guidesY }
      : drawing
        ? { x: drawing.guidesX, y: drawing.guidesY }
        : { x: [] as number[], y: [] as number[] }

  const actions: CanvasCardActions = useMemo(
    () => ({
      onDragStart: handleDragStart,
      onResizeStart: handleResizeStart,
      onStop: stopCard,
      onRegenerate: handleRegenerate,
      onEdit: handleEdit,
      onAskAnother: askAnotherExpansion,
      onDelete: handleDelete,
      onContinue: handleContinue,
      onContextMenu: selection.handleContextMenu,
      onOpenExpansion: handleOpenExpansion,
      onGoToSource: goToSource,
      onCardKeyDown: handleCardKeyDown
    }),
    [
      askAnotherExpansion,
      goToSource,
      handleCardKeyDown,
      handleContinue,
      handleDelete,
      handleDragStart,
      handleEdit,
      handleOpenExpansion,
      handleRegenerate,
      handleResizeStart,
      selection.handleContextMenu,
      stopCard
    ]
  )

  const isDrawMode = tool === 'select' || placing !== null
  const surfaceClasses = [
    'canvas-surface',
    isDrawMode ? 'is-drawing' : '',
    spaceHeld || gesture?.type === 'pan' ? 'is-panning' : '',
    placing ? 'is-placing' : ''
  ]
    .filter(Boolean)
    .join(' ')
  const message = notice ?? selection.notice

  return (
    <div className="canvas-view">
      <div
        ref={surfaceRef}
        className={surfaceClasses}
        onPointerDown={handleSurfaceDown}
        onMouseDown={handleSurfaceMouseDown}
        onPointerMove={handleSurfaceMove}
        onPointerUp={handleSurfaceUp}
        onPointerCancel={() => setGesture(null)}
      >
        <div ref={worldRef} className={`canvas-world${animating ? ' is-animating' : ''}`}>
          {displayed.map((card) => {
            const dragging =
              (gesture?.type === 'drag' && gesture.ids.has(card.id)) ||
              (gesture?.type === 'resize' &&
                (gesture.id === card.id ||
                  (resizeUpdates?.some((update) => update.id === card.id) ?? false)))
            const invalid = refusedIds.has(card.id)
            return (
              <CanvasCardView
                key={card.id}
                card={card}
                rect={card.rect}
                {...cardContent(card, canvas)}
                {...actions}
                dragging={dragging}
                roomRight={adjacentSlot(card, 'right', displayed) !== null}
                roomBottom={adjacentSlot(card, 'bottom', displayed) !== null}
                invalid={invalid}
                pulsing={pulseId === card.id}
                dimmed={placing !== null && placing.hostId !== card.id}
                continued={continuedId === card.id}
                pulseTermId={pulseTerm?.cardId === card.id ? pulseTerm.expansionId : null}
              />
            )
          })}
          <CanvasLinks
            cards={displayed}
            surfaceRef={surfaceRef}
            dragging={gesture?.type === 'drag' || gesture?.type === 'resize'}
            onFollow={handleFollowLink}
          />
          {draft && draftRect ? (
            <CanvasDraft
              key={draft.key}
              rect={draftRect}
              sessions={draftSessions}
              parentId={draftParent?.id}
              waiting={
                parentStatus === 'streaming'
                  ? WAITING_PARENT
                  : parentStatus === 'failed'
                    ? FAILED_PARENT
                    : null
              }
              onParentChange={changeDraftParent}
              onActivity={refollow}
              onCancel={cancelDraft}
              onSubmit={submitDraft}
            />
          ) : null}
          {activeGuides.x.map((x) => (
            <span key={`x${x}`} className="canvas-guide canvas-guide--x" style={{ left: x }} />
          ))}
          {activeGuides.y.map((y) => (
            <span key={`y${y}`} className="canvas-guide canvas-guide--y" style={{ top: y }} />
          ))}
          {drawing && gesture?.type === 'draw' ? (
            <div
              className={`canvas-draw-rect${drawing.refusal ? ' is-invalid' : ''}`}
              style={{
                transform: `translate(${drawing.rect.x}px, ${drawing.rect.y}px)`,
                width: drawing.rect.w,
                height: drawing.rect.h
              }}
            >
              <span className="canvas-draw-badge">
                ≈ {estimateWords(drawing.rect, drawCaption)} words
                {drawParent
                  ? drawSessions.length > 1
                    ? ` · continues the newest of ${drawSessions.length} sessions`
                    : ' · continues session'
                  : ''}
              </span>
            </div>
          ) : null}
        </div>
        {cards.length === 0 && !draft && !drawing ? (
          <div className="canvas-empty">
            <h2>Draw a rectangle</h2>
            <p>
              Delta writes an answer sized to fit it. Draw against a side to continue, or press N to
              type a question right away.
            </p>
          </div>
        ) : null}
      </div>

      <div className="canvas-toolbar canvas-toolbar--tools" role="toolbar" aria-label="Tools">
        <button
          type="button"
          className={`canvas-tool${tool === 'move' && !placing ? ' is-active' : ''}`}
          aria-pressed={tool === 'move' && !placing}
          title="Move and read (V). Drag empty space to pan."
          onClick={() => {
            setPlacing(null)
            setTool('move')
          }}
        >
          Move
        </button>
        <button
          type="button"
          className={`canvas-tool${isDrawMode ? ' is-active' : ''}`}
          aria-pressed={isDrawMode}
          title="Select an area for a new answer (R)"
          onClick={() => setTool('select')}
        >
          Select area
        </button>
      </div>

      <div className="canvas-toolbar canvas-toolbar--title">
        <input
          key={canvas.title}
          className="canvas-title"
          aria-label="Canvas name"
          defaultValue={canvas.title}
          onBlur={(e) => canvas.rename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <button
          type="button"
          className="canvas-tool"
          aria-haspopup="menu"
          title="Other canvases"
          onClick={openCanvasMenu}
        >
          ▾
        </button>
        <button
          type="button"
          className="canvas-tool"
          title="Save this canvas as markdown"
          disabled={cards.length === 0 || exportState === 'exporting'}
          onClick={() => void handleExport()}
        >
          {exportState === 'exporting'
            ? 'Exporting…'
            : exportState === 'saved'
              ? 'Saved'
              : 'Export'}
        </button>
      </div>

      <div className="canvas-toolbar canvas-toolbar--zoom" role="toolbar" aria-label="Zoom">
        <button
          type="button"
          className="canvas-tool"
          aria-label="Zoom out (−)"
          title="Zoom out (−)"
          onClick={() => zoomBy(1 / ZOOM_STEP)}
        >
          −
        </button>
        <button
          type="button"
          className="canvas-tool canvas-zoom-value"
          title="Reset to 100%"
          onClick={() => zoomBy(1 / viewportRef.current.zoom)}
        >
          <span ref={zoomValueRef} />
        </button>
        <button
          type="button"
          className="canvas-tool"
          aria-label="Zoom in (+)"
          title="Zoom in (+)"
          onClick={() => zoomBy(ZOOM_STEP)}
        >
          +
        </button>
        <button
          type="button"
          className="canvas-tool"
          title="Show everything (0)"
          onClick={showEverything}
        >
          Fit
        </button>
        <button
          type="button"
          className={`canvas-tool${helpOpen ? ' is-active' : ''}`}
          aria-label="Keyboard shortcuts (?)"
          aria-expanded={helpOpen}
          title="Keyboard shortcuts (?)"
          onClick={() => setHelpOpen((open) => !open)}
        >
          ?
        </button>
      </div>

      {helpOpen ? <CanvasShortcuts onClose={() => setHelpOpen(false)} /> : null}

      <div className="canvas-bottom">
        {placing || message ? (
          <div className="canvas-hint" role="status">
            {message ?? (
              <>
                Draw inside the message to size the answer to “{placing?.label}”, or click for the
                default size. Esc cancels.
              </>
            )}
          </div>
        ) : null}
        {draftHidden ? (
          <button
            type="button"
            className="canvas-jump"
            title="Bring your question box back into view (Enter)"
            onClick={() => {
              refollow()
              surfaceRef.current
                ?.querySelector<HTMLTextAreaElement>('[data-canvas-draft] textarea')
                ?.focus({ preventScroll: true })
            }}
          >
            Back to your question
          </button>
        ) : null}
      </div>

      <ContextMenu
        state={selection.ctxMenu ?? listMenu}
        onClose={() => {
          selection.closeContextMenu()
          setListMenu(null)
        }}
      />
      <ExpandPrompt state={selection.expandPrompt} onClose={selection.closeExpandPrompt} />
      <ExpandSelectionBar state={selection.selectionBar} />
    </div>
  )
}

/** Remounts the board per canvas, so a half-drawn rectangle never carries over. */
function CanvasView({ canvas }: { canvas: Canvas }): React.JSX.Element {
  const { ensureLoaded, loaded, canvasId } = canvas
  useEffect(() => {
    ensureLoaded()
  }, [ensureLoaded])
  if (!loaded) return <div className="canvas-view" />
  return <CanvasBoard key={canvasId} canvas={canvas} />
}

export default CanvasView
