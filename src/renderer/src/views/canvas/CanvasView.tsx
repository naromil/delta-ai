import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  CanvasCard,
  CanvasLinkContext,
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
  DEFAULT_NOTE_SIZE,
  FAR_ZOOM,
  MIN_EXPANSION_SIZE,
  MIN_FRAME_SIZE,
  MIN_MESSAGE_SIZE,
  MIN_NOTE_SIZE,
  adjacentSlot,
  cardRects,
  cardStackRanks,
  cascadeCardIds,
  clampPointInside,
  containsPoint,
  continuationCandidates,
  continueHandleBlocked,
  draftGrowth,
  estimateWords,
  fitViewport,
  fitsOnScreen,
  gridSpacing,
  nearestCardInDirection,
  openCardSize,
  rectAgainst,
  rectCenteredAt,
  rectFromCorner,
  rectClearOf,
  rectFromPoints,
  rectsOverlap,
  resizeCard,
  resizeFollowerIds,
  resizeDraftRect,
  resolveMove,
  sessionCardIds,
  turnsThroughCard,
  revealRect,
  screenToWorld,
  snapEdges,
  snapMove,
  sourceCardId,
  unionRect,
  visibleWorldRect,
  wheelZoomFactor,
  zoomAt
} from '../../../../shared/canvas'
import type { CanvasArrangeResult } from '../../../../shared/canvas-arrange'
import {
  alignSelection,
  distributeSelection,
  selectionBlockCount
} from '../../../../shared/canvas-arrange'
import { tidySelection } from '../../../../shared/canvas-tidy'
import { canvasOutline } from '../../../../shared/canvas-outline'
import {
  boundsOf,
  cardAtPoint,
  cardsInsideFrame,
  marqueeHits,
  movingBounds,
  movingForSelection,
  selectedCards,
  selectionMarkdown,
  sessionAncestorIds,
  sharedColor
} from '../../../../shared/canvas-selection'
import type { CanvasContextLink } from '../../../../shared/canvas-context'
import { contextExcerpts, sessionContextLinks } from '../../../../shared/canvas-context'
import { estimateTokens } from '../../../../shared/context-budget'
import type { ExpansionTarget } from '../../../../shared/rich-text'
import { flattenMarkdown } from '../../../../shared/rich-text'
import ContextMenu from '../../components/conversation/ContextMenu'
import type { ContextMenuItem, ContextMenuState } from '../../components/conversation/ContextMenu'
import ExpandPrompt from '../../components/conversation/ExpandPrompt'
import ExpandSelectionBar from '../../components/conversation/ExpandSelectionBar'
import type { useCanvas } from '../../hooks/useCanvas'
import { useExpansionContextMenu } from '../../hooks/useExpansionContextMenu'
import { formatRelativeTime } from '../../lib/format'
import type { ViewportMotion } from '../../lib/viewport-motion'
import { createViewportMotion } from '../../lib/viewport-motion'
import CanvasCardView from './CanvasCardView'
import type { CanvasCardActions } from './CanvasCardView'
import type { CanvasDraftContext } from './CanvasDraft'
import CanvasDraft from './CanvasDraft'
import CanvasFrameView from './CanvasFrames'
import CanvasIcon from './CanvasIcons'
import CanvasLinks from './CanvasLinks'
import type { CanvasMinimapHandle } from './CanvasMinimap'
import CanvasMinimap from './CanvasMinimap'
import CanvasNoteView, { CanvasNoteDraft } from './CanvasNoteView'
import CanvasOutline from './CanvasOutline'
import CanvasSelectionBar from './CanvasSelectionBar'
import CanvasShortcuts from './CanvasShortcuts'
import type { CanvasTool } from './CanvasToolRail'
import CanvasToolRail from './CanvasToolRail'
import {
  canScrollBy,
  confirmCascade,
  deletedNotice,
  dependentsPhrase,
  measureCardHeight,
  readMinimapPreference,
  releaseFocus,
  saveMinimapPreference,
  scrollIntoBody,
  termPoint,
  wheelPanDelta
} from './board-helpers'
import { cardContent } from './card-content'
import { bodyCharWidth } from '../../lib/char-width'
import { createRightDrag } from './right-drag'
import { cardMenuItems, frameMenuItems, linkMenuItems, planeMenuItems } from './canvas-menus'
import { ZOOM_STEP, useCanvasKeyboard } from './useCanvasKeyboard'
import { useEdgePan } from './useEdgePan'

type Canvas = ReturnType<typeof useCanvas>
type DrawKind = 'answer' | 'note' | 'frame'

type Gesture =
  | { type: 'pan'; pointer: CanvasPoint; origin: CanvasViewport }
  | {
      type: 'draw'
      what: DrawKind
      start: CanvasPoint
      end: CanvasPoint
      /** The card this rectangle follows, wherever it ends up. */
      continues?: string
      /** Sizing after a `+` was dropped: it tracks the pointer until the next click. */
      unheld?: boolean
    }
  | {
      type: 'marquee'
      start: CanvasPoint
      end: CanvasPoint
      /** What stays selected whatever the box catches: Shift adds to the selection. */
      base: ReadonlySet<string>
    }
  | {
      type: 'drag'
      /** The card or frame under the pointer. */
      id: string
      ids: Set<string>
      frameIds: Set<string>
      /** Snaps the moving bounds rather than one card, since several things were chosen. */
      group: boolean
      /** A press that never moves selects just this item. */
      plainPress: boolean
      /** Shift+drag carries what is joined, so Shift+click only decides once it is let go. */
      shiftPress: boolean
      start: CanvasPoint
      pointer: CanvasPoint
    }
  | { type: 'resize'; id: string; start: CanvasPoint; pointer: CanvasPoint }
  | { type: 'frameResize'; id: string; start: CanvasPoint; pointer: CanvasPoint }
  | { type: 'connect'; from: string; pointer: CanvasPoint }
  /** A card's `+` on its way somewhere: a click continues on its side. */
  | { type: 'extend'; from: string; side: CanvasSide; start: CanvasPoint; pointer: CanvasPoint }
  | {
      type: 'draftResize'
      side: CanvasSide | undefined
      rect: CanvasRect
      start: CanvasPoint
      pointer: CanvasPoint
    }

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
  /** Cards the question is about: their text goes along, not their history. */
  sourceIds?: string[]
  /** What it links into its branch; these become context links when it is sent. */
  context?: CanvasContextLink[]
}

/** A chosen expansion waiting for the rectangle that decides its size. */
interface Placing {
  turnId: number
  target: ExpansionTarget
  prompt?: string
  hostId: string
  label: string
}

interface CanvasNotice {
  text: string
  /** The notice offers to take back what it reports. */
  undoable?: boolean
}

interface DrawOutcome {
  rect: CanvasRect
  guidesX: number[]
  guidesY: number[]
  /** Why this rectangle cannot be used; null when it can. */
  refusal: string | null
}

const SNAP_SCREEN_PX = 10
const VIEWPORT_TRANSITION_MS = 360
const PULSE_MS = 900
const NOTICE_MS = 4000
const EXPORT_SAVED_MS = 2000

const REFUSE_TOO_SMALL = 'That rectangle is too small to hold an answer. Draw a larger one.'
const REFUSE_ARRANGE = 'Other cards are in the way of that arrangement.'
const ALREADY_TIDY = 'Already tidy.'
const NO_CARD_TO_CONNECT = 'Start a connection on a card.'
const CONNECT_ANOTHER = 'Drag to a different card to connect them.'
const NO_CONTINUE_FAILED = 'Retry this answer before continuing it.'
const WAITING_PARENT = 'Waiting for the answer it continues…'
const FAILED_PARENT = 'The answer it continues failed. Retry it first.'
const WAITING_CONTEXT = 'Waiting for a linked answer…'
const LINK_IN_HISTORY = 'That card is already in this conversation.'
const EXTEND_HINT = 'Let go in open space to place the next message, or on a new message to link.'
const SIZE_HINT = 'Move to size the next message, then click. A click right away uses the default.'

const TOOL_HINTS: Readonly<Partial<Record<CanvasTool, string>>> = {
  answer: 'Draw a rectangle for the answer, or click for the default size.',
  note: 'Draw where the note goes, or click for the default size.',
  frame: 'Draw a region. Whatever stands inside it moves with it.',
  connect: 'Drag from one card to another.',
  hand: 'Drag anywhere to pan.'
}

/** Below this much pointer travel on screen, a press is a click rather than a drag. */
const DRAG_START_PX = 3
const DOUBLE_PRESS_MS = 400
const NUDGE = 10
const NUDGE_LARGE = 50
/** Room left around what a new frame wraps, and the size of one made with a click. */
const FRAME_PADDING = 32
const DEFAULT_FRAME_SIZE = { w: 520, h: 360 }
/** How much of the surface the open outline covers, rail included. */
const OUTLINE_WIDTH = 344
/** Where a jump lands if the view is too far out to read what it was looking for. */
const READING_ZOOM = 0.8
const VIEW_HISTORY_LIMIT = 50

/** Space kept around a new session opened from the keyboard. */
const NEW_SESSION_GAP = 48
/** How much of the plane around a term is brought on screen when returning to it. */

const ARROW_SIDES: Readonly<Record<string, CanvasSide>> = {
  ArrowRight: 'right',
  ArrowLeft: 'left',
  ArrowDown: 'bottom',
  ArrowUp: 'top'
}

/** Keeps a run of wheel events on what it started moving as things pass under the pointer. */
const WHEEL_LATCH_MS = 160

function CanvasBoard({ canvas }: { canvas: Canvas }): React.JSX.Element {
  const { cards, frames, links, stack, viewport, turns, setViewport, moveItems, raiseCards } =
    canvas
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [tool, setTool] = useState<CanvasTool>(cards.length === 0 ? 'answer' : 'select')
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [placing, setPlacing] = useState<Placing | null>(null)
  const [notice, setNotice] = useState<CanvasNotice | null>(null)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [noteDraft, setNoteDraft] = useState<{ key: number; rect: CanvasRect } | null>(null)
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [editingFrameId, setEditingFrameId] = useState<string | null>(null)
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [outlineFocus, setOutlineFocus] = useState(0)
  const [searchMatches, setSearchMatches] = useState<ReadonlySet<string> | null>(null)
  const [minimapOpen, setMinimapOpen] = useState(readMinimapPreference)
  const [hoverCardId, setHoverCardId] = useState<string | null>(null)
  const outlineOpenRef = useRef(outlineOpen)
  useEffect(() => {
    outlineOpenRef.current = outlineOpen
  }, [outlineOpen])
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
  const minimapRef = useRef<CanvasMinimapHandle>(null)
  const viewBackRef = useRef<CanvasViewport[]>([])
  const viewForwardRef = useRef<CanvasViewport[]>([])
  /** Where the pointer last was on the surface: for edge panning and pasting. */
  const lastPointerRef = useRef<{ clientX: number; clientY: number } | null>(null)
  /** Where the gesture under way began: a press that has not moved does not edge-pan. */
  const pressRef = useRef<{ clientX: number; clientY: number } | null>(null)
  const lastPressRef = useRef<{ key: string; at: number } | null>(null)
  const doublePressedRef = useRef(false)
  const lastCopyRef = useRef<{ text: string; ids: ReadonlySet<string> } | null>(null)
  const zoomToItemRef = useRef<(id: string) => void>(() => undefined)
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
    minimapRef.current?.paint(next)
  }, [])

  // The plane's position is never a React style prop: frames in motion are written
  // directly, and React's diff would skip a viewport equal to the one it last rendered.
  useLayoutEffect(() => {
    paintViewport(viewport)
    // Inherited by every card, so it is restyled only at rest, never frame by frame.
    worldRef.current?.style.setProperty('--canvas-zoom', String(viewport.zoom))
    surfaceRef.current?.toggleAttribute('data-far', viewport.zoom < FAR_ZOOM)
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

  const showNotice = useCallback((text: string, undoable = false): void => {
    setNotice({ text, undoable })
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
  const stackRef = useRef(stack)
  const framesRef = useRef(frames)
  const linksRef = useRef(links)
  const selectedRef = useRef(selectedIds)
  useEffect(() => {
    cardsRef.current = cards
    framesRef.current = frames
    linksRef.current = links
    stackRef.current = stack
    selectedRef.current = selectedIds
  }, [cards, frames, links, selectedIds, stack])

  // However a card came to be chosen, by key, outline or marquee, it should be visible.
  useEffect(() => raiseCards(selectedIds), [raiseCards, selectedIds])

  const select = useCallback((ids: Iterable<string>): void => {
    const next = new Set(ids)
    selectedRef.current = next
    setSelectedIds(next)
  }, [])

  // Undo, a cascade or a canvas load can take away what was selected.
  useEffect(() => {
    const known = new Set([
      ...cards.map((card) => card.id),
      ...frames.map((frame) => frame.id),
      ...links.map((link) => link.id)
    ])
    const kept = [...selectedRef.current].filter((id) => known.has(id))
    if (kept.length !== selectedRef.current.size) select(kept)
  }, [cards, frames, links, select])

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
    (what: DrawKind, start: CanvasPoint, end: CanvasPoint): DrawOutcome => {
      const threshold = SNAP_SCREEN_PX / viewport.zoom
      const others = cardRects(cards)
      const raw = rectFromPoints(start, end)
      const isClick = raw.w < CLICK_DRAG_LIMIT && raw.h < CLICK_DRAG_LIMIT

      if (what === 'frame') {
        const snapped = snapEdges(
          isClick ? rectFromCorner(start, DEFAULT_FRAME_SIZE) : raw,
          others,
          threshold
        )
        const tooSmall = snapped.rect.w < MIN_FRAME_SIZE.w || snapped.rect.h < MIN_FRAME_SIZE.h
        return { ...snapped, refusal: tooSmall ? REFUSE_TOO_SMALL : null }
      }

      const min = placing ? MIN_EXPANSION_SIZE : what === 'note' ? MIN_NOTE_SIZE : MIN_MESSAGE_SIZE
      const clickSize = placing
        ? DEFAULT_EXPANSION_SIZE
        : what === 'note'
          ? DEFAULT_NOTE_SIZE
          : DEFAULT_MESSAGE_SIZE
      const snapped: SnapResult = snapEdges(
        isClick ? rectFromCorner(start, clickSize) : raw,
        others,
        threshold
      )
      const tooSmall = snapped.rect.w < min.w || snapped.rect.h < min.h
      return { ...snapped, refusal: tooSmall ? REFUSE_TOO_SMALL : null }
    },
    [cards, placing, viewport.zoom]
  )

  const finishDraw = useCallback(
    (what: DrawKind, start: CanvasPoint, end: CanvasPoint, continues?: string): void => {
      const outcome = drawnRect(what, start, end)
      if (outcome.refusal) {
        showNotice(outcome.refusal)
        return
      }
      if (what === 'frame') {
        const id = canvas.addFrame(outcome.rect, '')
        select([id])
        setEditingFrameId(id)
        setTool('select')
        return
      }
      if (what === 'note') {
        setNoteDraft({ key: ++draftKeyRef.current, rect: outcome.rect })
        setTool('select')
        return
      }
      if (placing) {
        const result = canvas.expand(placing.turnId, placing.target, placing.prompt, {
          hostId: placing.hostId,
          rect: outcome.rect
        })
        if (!result.ok) showNotice('That selection is no longer available. Select it again.')
        setPlacing(null)
        setTool('select')
        return
      }
      const touching = continuationCandidates(outcome.rect, cards).map((card) => card.id)
      const sessions = continues
        ? [continues, ...touching.filter((id) => id !== continues)]
        : touching
      followRef.current = true
      setDraft({
        key: ++draftKeyRef.current,
        rect: outcome.rect,
        ...(sessions.length > 0 ? { parentId: sessions[0] } : {}),
        sessions
      })
      setTool('select')
    },
    [canvas, cards, drawnRect, placing, select, showNotice]
  )

  /* ---- Pointer gestures ---- */

  const drawKind: DrawKind | null =
    tool === 'answer' || tool === 'note' || tool === 'frame' ? tool : null
  const isDrawMode = drawKind !== null || placing !== null

  /*
   * A gesture owns its press from here. It cannot cancel pointerdown for that: doing so
   * also suppresses mousedown, which is how open menus and prompts notice an outside click.
   */
  const claimedPressRef = useRef(false)
  const claimPress = useCallback((e: React.PointerEvent): void => {
    claimedPressRef.current = true
    pressRef.current = { clientX: e.clientX, clientY: e.clientY }
    lastPointerRef.current = pressRef.current
    motionRef.current?.settle()
    surfaceRef.current?.setPointerCapture(e.pointerId)
  }, [])

  // Stops text selection and middle-click autoscroll. Runs after a closing menu has
  // handed focus back, so that focus is released too.
  const handleSurfaceMouseDown = (e: React.MouseEvent): void => {
    if (doublePressedRef.current) {
      // The press already opened an editor; focusing what it landed on would close it.
      doublePressedRef.current = false
      e.preventDefault()
      return
    }
    if (!claimedPressRef.current) return
    claimedPressRef.current = false
    e.preventDefault()
    releaseFocus(e.target as Element)
  }

  /**
   * Whether this press and the one before it, on the same thing, make a double click.
   * It is counted by hand: a claimed press captures the pointer, so `dblclick` would
   * reach the surface rather than what was pressed.
   */
  const isDoublePress = useCallback((key: string, at: number): boolean => {
    const last = lastPressRef.current
    const double = last !== null && last.key === key && at - last.at < DOUBLE_PRESS_MS
    lastPressRef.current = double ? null : { key, at }
    doublePressedRef.current = double
    return double
  }, [])

  const [rightDrag] = useState(createRightDrag)

  const focusDraftInput = (): void => {
    surfaceRef.current
      ?.querySelector<HTMLTextAreaElement>('.canvas-card--draft textarea')
      ?.focus({ preventScroll: true })
  }

  /** Adds cards to what the composer sends; one already in its history has nothing to add. */
  const linkToDraft = (ids: string[]): void => {
    if (!draft) return
    const context = draft.context ?? []
    const history = sessionCardIds(cards, draft.parentId)
    if (ids.some((id) => history.includes(id))) showNotice(LINK_IN_HISTORY)
    const added = ids
      .filter((id) => !history.includes(id) && context.every((link) => link.from !== id))
      .map((from): CanvasContextLink => {
        const isNote = cards.some((card) => card.id === from && card.kind === 'note')
        return { from, context: isNote ? 'card' : 'branch' }
      })
    if (added.length > 0) setDraft({ ...draft, context: [...context, ...added] })
    focusDraftInput()
  }

  /*
   * While a dropped `+` is being sized, a press belongs to it whatever it lands on, so it is
   * taken before a card's own handlers. Any other button gives up.
   */
  /** A press on a card that something covers brings it forward, whatever the press goes on to do. */
  const raisePressedCard = (e: React.PointerEvent): void => {
    if (tool !== 'select' || placing || spaceHeld || e.button === 1) return
    const id = (e.target as Element).closest('[data-canvas-card]')?.getAttribute('data-canvas-card')
    if (id) raiseCards([id])
  }

  const handleSizingPress = (e: React.PointerEvent): void => {
    raisePressedCard(e)
    if (gesture?.type !== 'draw' || !gesture.unheld) return
    if (e.button !== 0) {
      setGesture(null)
      return
    }
    e.stopPropagation()
    const { what, start, continues } = gesture
    claimPress(e)
    setGesture({
      type: 'draw',
      what,
      start,
      end: pointerInWorld(e),
      ...(continues ? { continues } : {})
    })
  }

  const handleSurfaceDown = (e: React.PointerEvent): void => {
    rightDrag.onPress(e)
    const target = e.target as Element
    const startPan = e.button === 1 || (e.button === 0 && (spaceHeld || tool === 'hand'))
    if (startPan) {
      window.getSelection()?.removeAllRanges()
      claimPress(e)
      unfollow()
      setGesture({ type: 'pan', pointer: pointerOnSurface(e), origin: viewportRef.current })
      return
    }
    if (e.button !== 0) return
    if (isDrawMode) {
      const start = pointerInWorld(e)
      claimPress(e)
      setGesture({
        type: 'draw',
        what: placing ? 'answer' : (drawKind as DrawKind),
        start,
        end: start
      })
      return
    }
    if (tool === 'connect') {
      const start = pointerInWorld(e)
      const from = cardAtPoint(cardsRef.current, start, stackRef.current)
      if (!from) {
        showNotice(NO_CARD_TO_CONNECT)
        return
      }
      claimPress(e)
      setGesture({ type: 'connect', from: from.id, pointer: start })
      return
    }
    // Links, labels, cards and frame titles each deal with their own press.
    if (
      target.closest(
        '.canvas-link-hit, .canvas-connector-label, .canvas-card, .canvas-frame-title, .canvas-frame-resize'
      )
    ) {
      return
    }
    const start = pointerInWorld(e)
    window.getSelection()?.removeAllRanges()
    if (isDoublePress('plane', e.timeStamp)) {
      askAt(start)
      return
    }
    claimPress(e)
    setGesture({
      type: 'marquee',
      start,
      end: start,
      base: e.shiftKey || e.ctrlKey || e.metaKey ? selectedRef.current : new Set()
    })
  }

  const moveGesture = (at: { clientX: number; clientY: number }): void => {
    if (!gesture) return
    if (gesture.type === 'pan') {
      const pointer = pointerOnSurface(at)
      const next = {
        ...gesture.origin,
        x: gesture.origin.x + pointer.x - gesture.pointer.x,
        y: gesture.origin.y + pointer.y - gesture.pointer.y
      }
      motionRef.current?.steer(() => next, true)
    } else if (gesture.type === 'draw' || gesture.type === 'marquee') {
      setGesture({ ...gesture, end: pointerInWorld(at) })
    } else {
      setGesture({ ...gesture, pointer: pointerInWorld(at) })
    }
  }

  const handleSurfaceMove = (e: React.PointerEvent): void => {
    lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY }
    const rightPress = rightDrag.onMove(e)
    if (rightPress) {
      window.getSelection()?.removeAllRanges()
      motionRef.current?.settle()
      surfaceRef.current?.setPointerCapture(rightPress.pointerId)
      unfollow()
      setGesture({
        type: 'pan',
        pointer: pointerOnSurface(rightPress),
        origin: viewportRef.current
      })
      return
    }
    if (gesture) {
      moveGesture(e)
    } else if (tool === 'connect') {
      setHoverCardId(cardAtPoint(cardsRef.current, pointerInWorld(e), stackRef.current)?.id ?? null)
    }
  }

  useEdgePan({
    active: gesture !== null && gesture.type !== 'pan' && gesture.type !== 'frameResize',
    surfaceRef,
    pressRef,
    pointerRef: lastPointerRef,
    onPan: useCallback(
      (dx: number, dy: number, at: { clientX: number; clientY: number }): void => {
        followRef.current = false
        motionRef.current?.steer((view) => ({ ...view, x: view.x + dx, y: view.y + dy }), true)
        const world = pointerInWorld(at)
        setGesture((current) => {
          if (!current || current.type === 'pan') return current
          if (current.type === 'draw' || current.type === 'marquee') {
            return { ...current, end: world }
          }
          return { ...current, pointer: world }
        })
      },
      [pointerInWorld]
    )
  })

  const dragDelta = useMemo((): {
    dx: number
    dy: number
    guidesX: number[]
    guidesY: number[]
  } => {
    const still = { dx: 0, dy: 0, guidesX: [], guidesY: [] }
    if (gesture?.type !== 'drag') return still
    const items = { cards, frames }
    const single = cards.find((item) => item.id === gesture.id)
    const subject =
      gesture.group || !single
        ? movingBounds(items, { cards: gesture.ids, frames: gesture.frameIds })
        : single.rect
    if (!subject) return still
    const travelX = gesture.pointer.x - gesture.start.x
    const travelY = gesture.pointer.y - gesture.start.y
    if (Math.hypot(travelX, travelY) * viewport.zoom < DRAG_START_PX) return still
    const moved = { ...subject, x: subject.x + travelX, y: subject.y + travelY }
    const snap = snapMove(moved, cardRects(cards, gesture.ids), SNAP_SCREEN_PX / viewport.zoom)
    return {
      dx: snap.rect.x - subject.x,
      dy: snap.rect.y - subject.y,
      guidesX: snap.guidesX,
      guidesY: snap.guidesY
    }
  }, [cards, frames, gesture, viewport.zoom])

  const resizedRect = useMemo((): CanvasRect | null => {
    if (gesture?.type !== 'resize') return null
    const card = cards.find((item) => item.id === gesture.id)
    if (!card) return null
    const min =
      card.kind === 'message'
        ? MIN_MESSAGE_SIZE
        : card.kind === 'note'
          ? MIN_NOTE_SIZE
          : MIN_EXPANSION_SIZE
    const rect = {
      ...card.rect,
      w: Math.max(card.rect.w + gesture.pointer.x - gesture.start.x, min.w),
      h: Math.max(card.rect.h + gesture.pointer.y - gesture.start.y, min.h)
    }
    // A card that follows the moving edge is not a target: it would hold the edge in place.
    const carried = new Set([card.id, ...resizeFollowerIds(cards, card.id)])
    const snapped = snapEdges(rect, cardRects(cards, carried), SNAP_SCREEN_PX / viewport.zoom).rect
    return { ...rect, w: snapped.x + snapped.w - rect.x, h: snapped.y + snapped.h - rect.y }
  }, [cards, gesture, viewport.zoom])

  const resizedDraft = useMemo(() => {
    if (gesture?.type !== 'draftResize') return null
    const grow = draftGrowth(gesture.side)
    return resizeDraftRect(
      gesture.rect,
      gesture.side,
      {
        dw: grow.x * (gesture.pointer.x - gesture.start.x),
        dh: grow.y * (gesture.pointer.y - gesture.start.y)
      },
      cardRects(cards),
      SNAP_SCREEN_PX / viewport.zoom
    )
  }, [cards, gesture, viewport.zoom])

  const resizedFrameRect = useMemo((): CanvasRect | null => {
    if (gesture?.type !== 'frameResize') return null
    const frame = frames.find((item) => item.id === gesture.id)
    if (!frame) return null
    return {
      ...frame.rect,
      w: Math.max(frame.rect.w + gesture.pointer.x - gesture.start.x, MIN_FRAME_SIZE.w),
      h: Math.max(frame.rect.h + gesture.pointer.y - gesture.start.y, MIN_FRAME_SIZE.h)
    }
  }, [frames, gesture])

  // What the box being dragged would select, shown live and committed when it is let go.
  const marqueeSelection =
    gesture?.type === 'marquee'
      ? new Set([
          ...gesture.base,
          ...marqueeHits({ cards, frames }, rectFromPoints(gesture.start, gesture.end))
        ])
      : null
  const liveSelection = marqueeSelection ?? selectedIds

  const dragResult = useMemo(
    () =>
      gesture?.type === 'drag' ? resolveMove(cards, gesture.ids, dragDelta.dx, dragDelta.dy) : null,
    [cards, dragDelta, gesture]
  )

  const resizeUpdates = useMemo(
    () =>
      gesture?.type === 'resize' && resizedRect
        ? resizeCard(cards, gesture.id, { w: resizedRect.w, h: resizedRect.h })
        : null,
    [cards, gesture, resizedRect]
  )

  const focusCardElement = (id: string): void => {
    surfaceRef.current
      ?.querySelector<HTMLElement>(`[data-canvas-card="${id}"]`)
      ?.focus({ preventScroll: true })
  }

  const finishConnect = (from: string, at: CanvasPoint): void => {
    const target = cardAtPoint(cards, at, stack)
    if (!target || target.id === from) {
      showNotice(CONNECT_ANOTHER)
      return
    }
    const id = canvas.addLink(from, target.id)
    if (id === null) return
    select([id])
    setEditingLinkId(id)
    setTool('select')
  }

  const handleDragStart = useCallback<CanvasCardActions['onDragStart']>(
    (e, id) => {
      const target = e.target as Element
      if (e.button !== 0 || (target.closest('button') && !target.closest('.canvas-frame-handle'))) {
        return
      }
      if (isDoublePress(id, e.timeStamp)) {
        if (framesRef.current.some((frame) => frame.id === id)) setEditingFrameId(id)
        else if (cardsRef.current.some((card) => card.id === id && card.kind === 'note')) {
          setEditingNoteId(id)
        } else zoomToItemRef.current(id)
        return
      }
      const start = pointerInWorld(e)
      const items = { cards: cardsRef.current, frames: framesRef.current }
      const additive = e.ctrlKey || e.metaKey
      const shiftPress = e.shiftKey && !additive
      const carrying = e.altKey ? 'pulled' : e.shiftKey ? 'joined' : 'detached'
      let chosen = selectedRef.current
      if (additive) {
        const next = new Set(chosen)
        if (!next.delete(id)) next.add(id)
        chosen = next
        select(next)
        if (!next.has(id)) return
      } else if (!chosen.has(id)) {
        chosen = new Set([id])
        if (!shiftPress) select(chosen)
      }
      const moving = movingForSelection(items, chosen, carrying)
      claimPress(e)
      currentIdRef.current = id
      setGesture({
        type: 'drag',
        id,
        ids: moving.cards,
        frameIds: moving.frames,
        group: chosen.size > 1 || moving.frames.size > 0,
        plainPress: !additive && !shiftPress,
        shiftPress,
        start,
        pointer: start
      })
    },
    [claimPress, isDoublePress, pointerInWorld, select]
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

  const handleFrameResizeStart = useCallback<CanvasCardActions['onResizeStart']>(
    (e, id) => {
      if (e.button !== 0) return
      const start = pointerInWorld(e)
      claimPress(e)
      setGesture({ type: 'frameResize', id, start, pointer: start })
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

  const { stopCard, regenerateCard, editCard, removeItems, exportCanvas, setCollapsed } = canvas
  const { undo, redo, addLink, setColor, duplicate, addNote, updateNote, addFrame } = canvas
  const { labelLink, reverseLink, setLinkContext, renameFrame } = canvas
  const { askAnotherExpansion } = selection

  /** Deletes, asking only about cards it would take along that were not chosen. */
  const deleteItems = useCallback(
    (ids: ReadonlySet<string>): void => {
      if (ids.size === 0) return
      const all = cardsRef.current
      const takenAlong = new Set<string>()
      for (const id of ids) {
        if (all.some((card) => card.id === id)) {
          for (const dependent of cascadeCardIds(all, id)) {
            if (!ids.has(dependent)) takenAlong.add(dependent)
          }
        }
      }
      const confirmed =
        takenAlong.size === 0 ||
        confirmCascade(
          `Delete this and ${dependentsPhrase(takenAlong.size)}?`,
          takenAlong.size,
          true
        )
      if (!confirmed) return
      removeItems(ids)
      select([])
      showNotice(deletedNotice(ids.size + takenAlong.size), true)
    },
    [removeItems, select, showNotice]
  )

  const handleDelete = useCallback(
    (id: string): void => {
      deleteItems(selectedRef.current.has(id) ? selectedRef.current : new Set([id]))
    },
    [deleteItems]
  )

  const confirmReplacing = useCallback((id: string): boolean => {
    const dependents = cascadeCardIds(cardsRef.current, id).size - 1
    if (dependents === 0) return true
    return confirmCascade(
      `This replaces the answer and removes ${dependentsPhrase(dependents)}. Continue?`,
      dependents,
      false
    )
  }, [])

  const handleRegenerate = useCallback(
    (id: string): void => {
      if (!confirmReplacing(id)) return
      // The rectangle decides the answer's length, so it needs its real height back.
      setCollapsed(new Set([id]), false)
      regenerateCard(id)
    },
    [confirmReplacing, regenerateCard, setCollapsed]
  )

  const handleEdit = useCallback(
    (id: string, question: string): boolean => {
      if (!confirmReplacing(id)) return false
      editCard(id, question)
      return true
    },
    [confirmReplacing, editCard]
  )

  const handleUndo = useCallback(
    (step: typeof undo): void => {
      const result = step()
      if (result && !result.ok) showNotice(result.reason)
    },
    [showNotice]
  )

  const handleCollapse = useCallback(
    (ids: ReadonlySet<string>): void => {
      const chosen = cardsRef.current.filter((card) => ids.has(card.id) && card.kind !== 'note')
      const allCollapsed = chosen.every(
        (card) => card.kind !== 'note' && card.collapsedFrom !== undefined
      )
      setCollapsed(ids, !allCollapsed)
    },
    [setCollapsed]
  )

  const handleToggleCollapse = useCallback(
    (id: string): void => handleCollapse(new Set([id])),
    [handleCollapse]
  )

  const applyArrangement = useCallback(
    (label: string, result: CanvasArrangeResult): void => {
      if (result.ok) moveItems(label, result.cards, result.frames)
      else showNotice(REFUSE_ARRANGE)
    },
    [moveItems, showNotice]
  )

  const applyTidy = useCallback(
    (result: CanvasArrangeResult): void => {
      if (result.ok) moveItems('Tidy up', result.cards, result.frames)
      else showNotice(ALREADY_TIDY)
    },
    [moveItems, showNotice]
  )

  const handleDuplicate = useCallback(
    (ids: ReadonlySet<string>): void => {
      const copies = duplicate(ids)
      if (copies.length > 0) select(copies)
      else showNotice('Nothing here can be copied yet.')
    },
    [duplicate, select, showNotice]
  )

  const handleCopy = useCallback(
    (ids: ReadonlySet<string>): void => {
      const items = { cards: cardsRef.current, frames: framesRef.current }
      const covered = new Set(selectedCards(items, ids).map((card) => card.id))
      const text = selectionMarkdown(items.cards, canvasRef.current.turns, covered)
      if (text === '') return
      lastCopyRef.current = { text, ids }
      navigator.clipboard.writeText(text).then(
        () => showNotice('Copied as markdown.'),
        () => showNotice('The clipboard is not available.')
      )
    },
    [showNotice]
  )

  /** A frame around the selection, with its title ready to type. */
  const frameSelection = useCallback(
    (ids: ReadonlySet<string>): void => {
      const bounds = boundsOf(
        [...cardsRef.current, ...framesRef.current]
          .filter((item) => ids.has(item.id))
          .map((item) => item.rect)
      )
      if (!bounds) return
      const id = addFrame(
        {
          x: bounds.x - FRAME_PADDING,
          y: bounds.y - FRAME_PADDING,
          w: bounds.w + FRAME_PADDING * 2,
          h: bounds.h + FRAME_PADDING * 2
        },
        ''
      )
      select([id])
      setEditingFrameId(id)
    },
    [addFrame, select]
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

  /** The part of the surface a jump should land in: not behind the outline. */
  const openArea = useCallback((): { left: number; width: number; height: number } => {
    const { width, height } = surfaceSize()
    const left = outlineOpenRef.current ? OUTLINE_WIDTH : 0
    return { left, width: width - left, height }
  }, [surfaceSize])

  /** The smallest glide that brings a rectangle on screen; none when it already is. */
  const revealOnScreen = useCallback(
    (rect: CanvasRect): void => {
      const { left, width, height } = openArea()
      const view = viewportRef.current
      const moved = revealRect({ ...view, x: view.x - left }, rect, { width, height })
      const next = { ...moved, x: moved.x + left }
      if (next.x !== view.x || next.y !== view.y) glideTo(next)
    },
    [glideTo, openArea]
  )

  /** Remembers where the view is, before a jump, for Alt+Left. */
  const rememberView = useCallback((): void => {
    viewBackRef.current = [...viewBackRef.current, viewportRef.current].slice(-VIEW_HISTORY_LIMIT)
    viewForwardRef.current = []
  }, [])

  const travelViewHistory = useCallback(
    (direction: 'back' | 'forward'): void => {
      const [from, to] =
        direction === 'back' ? [viewBackRef, viewForwardRef] : [viewForwardRef, viewBackRef]
      const next = from.current.at(-1)
      if (!next) return
      from.current = from.current.slice(0, -1)
      to.current = [...to.current, viewportRef.current]
      followRef.current = false
      glideTo(next)
    },
    [glideTo]
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
    (id: string, pulse = false, extend = false): void => {
      const card = cardsRef.current.find((item) => item.id === id)
      if (!card) return
      unfollow()
      currentIdRef.current = id
      select(extend ? [...selectedRef.current, id] : [id])
      revealOnScreen(card.rect)
      surfaceRef.current
        ?.querySelector<HTMLElement>(`[data-canvas-card="${id}"]`)
        ?.focus({ preventScroll: true })
      if (pulse) flash(id)
    },
    [flash, revealOnScreen, select, unfollow]
  )

  /**
   * Brings all of a card on screen, zooming out only when it would not fit otherwise. Past
   * the zoom where cards become titles its text would be gone, so a card too tall for that
   * is centred on `focus` instead.
   */
  const revealWholeCard = useCallback(
    (rect: CanvasRect, focus: CanvasPoint): void => {
      const { left, width, height } = openArea()
      const { zoom } = viewportRef.current
      if (zoom >= FAR_ZOOM && fitsOnScreen(rect, zoom, { width, height })) {
        revealOnScreen(rect)
        return
      }
      const fit = fitViewport([rect], { width, height })
      glideTo(
        fit.zoom >= FAR_ZOOM
          ? { ...fit, x: fit.x + left }
          : {
              x: left + width / 2 - focus.x * FAR_ZOOM,
              y: height / 2 - focus.y * FAR_ZOOM,
              zoom: FAR_ZOOM
            }
      )
    },
    [glideTo, openArea, revealOnScreen]
  )

  /** From an expansion back to the card its term is in: all of it, with the term flashed. */
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
      const point = termPoint(term)
      // First: after a key press this focus reveals the card by itself, which must not win.
      term.focus({ preventScroll: true })
      revealWholeCard(host.rect, {
        x: host.rect.x + (point.x - hostBox.left) / scale,
        y: host.rect.y + (point.y - hostBox.top) / scale
      })
      currentIdRef.current = host.id
      flash(host.id, card.expansionId)
    },
    [flash, focusCard, revealWholeCard, unfollow]
  )

  const goToSource = useCallback(
    (id: string): void => {
      const card = cardsRef.current.find((item) => item.id === id)
      if (!card) return
      rememberView()
      if (card.kind === 'expansion') {
        returnToTerm(id)
        return
      }
      const source = sourceCardId(card)
      if (source !== undefined) focusCard(source, true)
    },
    [focusCard, rememberView, returnToTerm]
  )

  const handleOpenExpansion = useCallback(
    (expansionId: number): void => {
      const card = cardsRef.current.find(
        (item) => item.kind === 'expansion' && item.expansionId === expansionId
      )
      if (!card) return
      rememberView()
      focusCard(card.id, true)
    },
    [focusCard, rememberView]
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
      if (toStart < toCard) {
        rememberView()
        focusCard(id, true)
      } else goToSource(id)
    },
    [focusCard, goToSource, pointerInWorld, rememberView]
  )

  /** A click on a card asked about's faint line goes to whichever card is farther away. */
  const handleFollowRelation = useCallback(
    (e: React.MouseEvent, from: string, to: string): void => {
      const all = cardsRef.current
      const start = all.find((card) => card.id === from)
      const end = all.find((card) => card.id === to)
      if (!start || !end) return
      const at = pointerInWorld(e)
      const distance = (rect: CanvasRect): number => {
        const edge = clampPointInside(at, rect)
        return Math.hypot(at.x - edge.x, at.y - edge.y)
      }
      rememberView()
      focusCard(distance(start.rect) > distance(end.rect) ? from : to, true)
    },
    [focusCard, pointerInWorld, rememberView]
  )

  const zoomToRects = useCallback(
    (rects: CanvasRect[]): void => {
      if (rects.length === 0) return
      unfollow()
      rememberView()
      const { left, width, height } = openArea()
      const fit = fitViewport(rects, { width, height })
      glideTo({ ...fit, x: fit.x + left })
    },
    [glideTo, openArea, rememberView, unfollow]
  )

  const zoomToItem = useCallback(
    (id: string): void => {
      const item = [...cardsRef.current, ...framesRef.current].find((other) => other.id === id)
      if (item) zoomToRects([item.rect])
    },
    [zoomToRects]
  )

  /** From the outline or search: the item is selected and brought somewhere it can be read. */
  const goToItem = useCallback(
    (id: string): void => {
      const frame = framesRef.current.find((item) => item.id === id)
      if (frame) {
        select([id])
        zoomToRects([frame.rect])
        flash(id)
        return
      }
      const all = cardsRef.current
      const card = all.find((item) => item.id === id)
      if (!card) return
      rememberView()
      if (viewportRef.current.zoom < FAR_ZOOM) {
        // Too far out to read it, so the jump also comes in close enough.
        const { left, width, height } = openArea()
        const fit = fitViewport([card.rect], { width, height })
        const zoom = Math.max(Math.min(READING_ZOOM, fit.zoom), FAR_ZOOM)
        const center = { x: card.rect.x + card.rect.w / 2, y: card.rect.y + card.rect.h / 2 }
        const close = {
          x: left + width / 2 - center.x * zoom,
          y: height / 2 - center.y * zoom,
          zoom
        }
        unfollow()
        glideTo(close)
        // React has not painted it yet, and focusCard below reveals from where this lands.
        viewportRef.current = close
      }
      focusCard(id, true)
    },
    [flash, focusCard, glideTo, openArea, rememberView, select, unfollow, zoomToRects]
  )

  /* ---- The composer: drafts, and the conversation they follow ---- */

  const openDraft = useCallback((next: Omit<Draft, 'key'>): void => {
    followRef.current = true
    setPlacing(null)
    setTool('select')
    setDraft({ ...next, key: ++draftKeyRef.current })
  }, [])

  /** A draft against the first free side of `sides`, sized like the card it continues. */
  const continueCard = useCallback(
    (id: string, sides: CanvasSide[]): void => {
      const card = cardsRef.current.find((item) => item.id === id)
      if (!card) return
      if (card.kind === 'note') {
        // A note holds no session to continue, so the next card is about it instead.
        const size = DEFAULT_MESSAGE_SIZE
        const side =
          sides.find((item) => adjacentSlot(card, item, cardsRef.current, size)) ?? sides[0]
        openDraft({ rect: rectAgainst(card.rect, side, size), sessions: [], sourceIds: [id] })
        return
      }
      if (cardContent(card, canvasRef.current).status === 'failed') {
        showNotice(NO_CONTINUE_FAILED)
        return
      }
      const full = openCardSize(card)
      const side =
        sides.find((item) => adjacentSlot(card, item, cardsRef.current, full) !== null) ?? sides[0]
      currentIdRef.current = id
      openDraft({
        rect: { ...card.rect, ...openCardSize(card) },
        parentId: id,
        side,
        sessions: [id]
      })
    },
    [openDraft, showNotice]
  )

  /**
   * A question about what is selected: a single answer simply continues, as its history
   * is the better context, and anything else goes along as text beside a new card.
   */
  const askAboutSelection = useCallback((): void => {
    const all = cardsRef.current
    const chosen = selectedCards({ cards: all, frames: framesRef.current }, selectedRef.current)
    const only = chosen.length === 1 ? chosen[0] : undefined
    if (only && only.kind !== 'note') {
      continueCard(only.id, ['bottom', 'right'])
      return
    }
    const bounds = boundsOf(chosen.map((card) => card.rect))
    if (!bounds) return
    const rect = rectClearOf(
      { x: bounds.x + bounds.w + NEW_SESSION_GAP, y: bounds.y, ...DEFAULT_MESSAGE_SIZE },
      cardRects(all),
      NEW_SESSION_GAP / 2
    )
    openDraft({ rect, sessions: [], sourceIds: chosen.map((card) => card.id) })
  }, [continueCard, openDraft])

  /** A draft at a point on the plane, for a double-click or a menu. */
  const askAt = useCallback(
    (point: CanvasPoint): void => {
      const rect = rectClearOf(
        rectFromCorner(point, DEFAULT_MESSAGE_SIZE),
        cardRects(cardsRef.current),
        NEW_SESSION_GAP / 2
      )
      openDraft({ rect, sessions: [] })
    },
    [openDraft]
  )

  const handleContinue = useCallback(
    (id: string, side: CanvasSide): void => continueCard(id, [side]),
    [continueCard]
  )

  const handleContinueStart = useCallback<CanvasCardActions['onContinueStart']>(
    (e, id, side) => {
      // Other tools and panning treat a press here like one anywhere else.
      if (e.button !== 0 || tool !== 'select' || placing || spaceHeld) return
      const start = pointerInWorld(e)
      claimPress(e)
      currentIdRef.current = id
      setGesture({ type: 'extend', from: id, side, start, pointer: start })
    },
    [claimPress, placing, pointerInWorld, spaceHeld, tool]
  )

  /** A `+` let go: a click continues on its side, a drag places the next message there. */
  const finishExtend = (extend: Extract<Gesture, { type: 'extend' }>): void => {
    const travel = Math.hypot(extend.pointer.x - extend.start.x, extend.pointer.y - extend.start.y)
    if (travel * viewport.zoom < DRAG_START_PX) {
      continueCard(extend.from, [extend.side])
    } else if (overDraft) {
      linkToDraft([extend.from])
    } else {
      setGesture({
        type: 'draw',
        what: 'answer',
        start: extend.pointer,
        end: extend.pointer,
        continues: extend.from,
        unheld: true
      })
    }
  }

  const handleSurfaceUp = (e: React.PointerEvent): void => {
    rightDrag.onRelease(e)
    claimedPressRef.current = false
    if (!gesture || (gesture.type === 'draw' && gesture.unheld)) return
    setGesture(null)
    if (gesture.type === 'draw') {
      finishDraw(gesture.what, gesture.start, gesture.end, gesture.continues)
    } else if (gesture.type === 'extend') {
      finishExtend(gesture)
    } else if (gesture.type === 'marquee') {
      select(marqueeSelection ?? [])
    } else if (gesture.type === 'connect') {
      finishConnect(gesture.from, gesture.pointer)
    } else if (gesture.type === 'draftResize') {
      if (resizedDraft) setDraft((prev) => prev && { ...prev, rect: resizedDraft.rect })
      focusDraftInput()
    } else if (gesture.type === 'frameResize') {
      if (resizedFrameRect) {
        moveItems('Resize frame', [], [{ id: gesture.id, rect: resizedFrameRect }])
      }
    } else if (gesture.type === 'drag') {
      if (dragDelta.dx === 0 && dragDelta.dy === 0) {
        if (gesture.plainPress) {
          select([gesture.id])
          focusCardElement(gesture.id)
        } else if (gesture.shiftPress) {
          const next = new Set(selectedIds)
          if (!next.delete(gesture.id)) next.add(gesture.id)
          select(next)
        }
        return
      }
      if (overDraft) {
        // Everything chosen goes along, and the cards return to where they stood.
        linkToDraft(
          selectedIds.has(gesture.id)
            ? cards.map((card) => card.id).filter((id) => selectedIds.has(id))
            : [gesture.id]
        )
        return
      }
      if (gesture.shiftPress && !selectedIds.has(gesture.id)) select([gesture.id])
      if (!dragResult) return
      const frameUpdates = frames
        .filter((frame) => gesture.frameIds.has(frame.id))
        .map((frame) => ({
          id: frame.id,
          rect: { ...frame.rect, x: frame.rect.x + dragDelta.dx, y: frame.rect.y + dragDelta.dy }
        }))
      moveItems('Move', dragResult, frameUpdates)
    } else if (gesture.type === 'resize' && resizedRect) {
      if (resizeUpdates) moveItems('Resize', resizeUpdates)
    }
  }

  /** A new session in open space near the middle of the screen. */
  const newSession = useCallback((): void => {
    const size = surfaceSize()
    const center = screenToWorld(viewportRef.current, { x: size.width / 2, y: size.height / 2 })
    const rect = rectClearOf(
      rectCenteredAt(center, DEFAULT_MESSAGE_SIZE),
      cardRects(cardsRef.current),
      NEW_SESSION_GAP
    )
    openDraft({ rect, sessions: [] })
  }, [openDraft, surfaceSize])

  const pasteAsNote = useCallback(
    (text: string): void => {
      const point = lastPointerRef.current
      const size = surfaceSize()
      const placed = point
        ? rectFromCorner(pointerInWorld(point), DEFAULT_NOTE_SIZE)
        : rectCenteredAt(
            screenToWorld(viewportRef.current, { x: size.width / 2, y: size.height / 2 }),
            DEFAULT_NOTE_SIZE
          )
      const rect = rectClearOf(placed, cardRects(cardsRef.current), NEW_SESSION_GAP / 2)
      select([addNote(rect, text)])
    },
    [addNote, pointerInWorld, select, surfaceSize]
  )

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
      all.find((card) => card.id === currentIdRef.current) ??
      all.findLast((card) => card.kind === 'message')
    if (current) continueCard(current.id, ['bottom', 'right'])
    else newSession()
  }, [continueCard, newSession, refollow])

  const navigateFromMinimap = useCallback(
    (point: CanvasPoint, dragging: boolean): void => {
      const { width, height } = surfaceSize()
      const { zoom } = viewportRef.current
      const next = { x: width / 2 - point.x * zoom, y: height / 2 - point.y * zoom, zoom }
      unfollow()
      if (dragging) {
        motionRef.current?.steer(() => next, true)
      } else {
        rememberView()
        glideTo(next)
      }
    },
    [glideTo, rememberView, surfaceSize, unfollow]
  )

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
    zoomToRects([
      ...cardsRef.current.map((card) => card.rect),
      ...framesRef.current.map((frame) => frame.rect)
    ])
  }, [zoomToRects])

  const zoomToSelection = useCallback((): void => {
    const chosen = [...cardsRef.current, ...framesRef.current].filter((item) =>
      selectedRef.current.has(item.id)
    )
    zoomToRects(chosen.map((item) => item.rect))
  }, [zoomToRects])

  const selectEverything = useCallback((): void => {
    select([
      ...cardsRef.current.map((card) => card.id),
      ...framesRef.current.map((frame) => frame.id)
    ])
  }, [select])

  const openOutline = useCallback((): void => {
    setOutlineOpen(true)
    setOutlineFocus((count) => count + 1)
  }, [])

  const nudgeSelection = useCallback(
    (side: CanvasSide, far: boolean): void => {
      const chosen = selectedRef.current
      const all = cardsRef.current
      const moving = movingForSelection(
        { cards: all, frames: framesRef.current },
        chosen,
        'detached'
      )
      if (moving.cards.size === 0 && moving.frames.size === 0) return
      const step = far ? NUDGE_LARGE : NUDGE
      const dx = side === 'left' ? -step : side === 'right' ? step : 0
      const dy = side === 'top' ? -step : side === 'bottom' ? step : 0
      moveItems(
        'Nudge',
        resolveMove(all, moving.cards, dx, dy),
        framesRef.current
          .filter((frame) => moving.frames.has(frame.id))
          .map((frame) => ({
            id: frame.id,
            rect: { ...frame.rect, x: frame.rect.x + dx, y: frame.rect.y + dy }
          }))
      )
    },
    [moveItems]
  )

  /* ---- Keyboard ---- */

  const handleCardKeyDown = useCallback(
    (e: React.KeyboardEvent, id: string): void => {
      const side = ARROW_SIDES[e.key]
      if (side) {
        e.preventDefault()
        const next = nearestCardInDirection(cardsRef.current, id, side)
        if (next) focusCard(next.id, false, e.shiftKey)
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

  const chooseTool = useCallback((next: CanvasTool): void => {
    setPlacing(null)
    setHoverCardId(null)
    setTool(next)
  }, [])

  const toggleMinimap = useCallback((): void => {
    setMinimapOpen((open) => {
      saveMinimapPreference(!open)
      return !open
    })
  }, [])

  useCanvasKeyboard({
    selectedRef,
    linksRef,
    framesRef,
    viewportRef,
    clearGesture: gesture ? () => setGesture(null) : null,
    closeHelp: helpOpen ? () => setHelpOpen(false) : null,
    cancelPlacing: placing ? () => setPlacing(null) : null,
    cancelDraft: draft ? () => setDraft(null) : null,
    clearSelection: () => select([]),
    resetTool: tool !== 'select' ? () => chooseTool('select') : null,
    toggleHelp: () => setHelpOpen((open) => !open),
    holdSpace: setSpaceHeld,
    chooseTool,
    toggleOutline: () => setOutlineOpen((open) => !open),
    openOutline,
    toggleMinimap,
    zoomToSelection,
    newSession,
    askAboutSelection,
    collapseSelection: () => handleCollapse(selectedRef.current),
    zoomBy,
    showEverything,
    deleteSelection: () => deleteItems(selectedRef.current),
    editLinkLabel: setEditingLinkId,
    editFrameTitle: setEditingFrameId,
    compose,
    panBy: (dx, dy) => {
      unfollow()
      motionRef.current?.steer((view) => ({ ...view, x: view.x + dx, y: view.y + dy }))
    },
    undo: () => handleUndo(undo),
    redo: () => handleUndo(redo),
    selectEverything,
    nudgeSelection,
    duplicateSelection: () => handleDuplicate(selectedRef.current),
    frameSelection: () => frameSelection(selectedRef.current),
    copySelection: () => handleCopy(selectedRef.current),
    travelViewHistory,
    pasteText: (text) => {
      const copied = lastCopyRef.current
      // Pasting what was just copied from here means the cards themselves.
      if (copied?.text === text) handleDuplicate(copied.ids)
      else pasteAsNote(text)
    }
  })

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
      if (target === cardEl && !selectedRef.current.has(card.id)) select([card.id])
      revealOnScreen(card.rect)
    }
    surface.addEventListener('scroll', handleScroll)
    surface.addEventListener('focusin', handleFocusIn)
    return () => {
      surface.removeEventListener('scroll', handleScroll)
      surface.removeEventListener('focusin', handleFocusIn)
    }
  }, [revealOnScreen, select])

  /* ---- Menus ---- */

  const openListMenu = useCallback(
    (e: React.MouseEvent, label: string, items: ContextMenuItem[]): void => {
      e.preventDefault()
      e.stopPropagation()
      setListMenu({ x: e.clientX, y: e.clientY, label, items })
    },
    []
  )

  const openPlaneMenu = (e: React.MouseEvent): void => {
    if ((e.target as Element).closest('.canvas-card, .canvas-frame-title, .canvas-link-hit')) return
    const at = pointerInWorld(e)
    openListMenu(
      e,
      'Canvas',
      planeMenuItems({
        askHere: () => askAt(at),
        noteHere: () => {
          const rect = rectClearOf(
            rectFromCorner(at, DEFAULT_NOTE_SIZE),
            cardRects(cards),
            NEW_SESSION_GAP / 2
          )
          setNoteDraft({ key: ++draftKeyRef.current, rect })
        },
        selectEverything,
        tidyUp: () => applyTidy(tidySelection({ cards, frames, links })),
        showEverything
      })
    )
  }

  const handleCardMenu = useCallback(
    (e: React.MouseEvent, id: string): void => {
      const card = cardsRef.current.find((item) => item.id === id)
      if (!card) return
      const chosen = selectedRef.current.has(id) ? selectedRef.current : new Set([id])
      if (chosen !== selectedRef.current) select(chosen)
      openListMenu(
        e,
        'Card',
        cardMenuItems(card, {
          ask: askAboutSelection,
          duplicate: () => handleDuplicate(chosen),
          copy: () => handleCopy(chosen),
          collapse: () => handleCollapse(chosen),
          frame: () => frameSelection(chosen),
          zoom: () => zoomToItem(id),
          remove: () => deleteItems(chosen)
        })
      )
    },
    [
      askAboutSelection,
      deleteItems,
      frameSelection,
      handleCollapse,
      handleCopy,
      handleDuplicate,
      openListMenu,
      select,
      zoomToItem
    ]
  )

  const handleFrameMenu = useCallback(
    (e: React.MouseEvent, id: string): void => {
      const frame = framesRef.current.find((item) => item.id === id)
      if (!frame) return
      const only = new Set([id])
      select(only)
      openListMenu(
        e,
        'Frame',
        frameMenuItems({
          rename: () => setEditingFrameId(id),
          zoom: () => zoomToItem(id),
          selectInside: () =>
            select(cardsInsideFrame(cardsRef.current, frame).map((card) => card.id)),
          duplicate: () => handleDuplicate(only),
          remove: () => deleteItems(only)
        })
      )
    },
    [deleteItems, handleDuplicate, openListMenu, select, zoomToItem]
  )

  const handleSelectLink = useCallback(
    (e: React.MouseEvent, id: string): void => {
      e.stopPropagation()
      const double = isDoublePress(id, e.timeStamp)
      // This is the click, so no mousedown follows for the double press to hold back.
      doublePressedRef.current = false
      if (double) setEditingLinkId(id)
      else select([id])
    },
    [isDoublePress, select]
  )

  const handleLinkMenu = useCallback(
    (e: React.MouseEvent, id: string): void => {
      const link = linksRef.current.find((item) => item.id === id)
      if (!link) return
      const only = new Set([id])
      select(only)
      openListMenu(
        e,
        'Connection',
        linkMenuItems({
          label: () => setEditingLinkId(id),
          context: {
            context: link.context,
            from: cardsRef.current.find((card) => card.id === link.from)?.kind,
            to: cardsRef.current.find((card) => card.id === link.to)?.kind,
            setContext: (context) => setLinkContext(id, context)
          },
          reverse: () => reverseLink(id),
          goToStart: () => goToItem(link.from),
          goToEnd: () => goToItem(link.to),
          remove: () => deleteItems(only)
        })
      )
    },
    [deleteItems, goToItem, openListMenu, reverseLink, select, setLinkContext]
  )

  /** A click that reached a card's body: it selects, unless it was the end of selecting text. */
  const handleCardClick = useCallback(
    (e: React.MouseEvent, id: string): void => {
      const target = e.target as Element
      if (target.closest('button, a, input, select, textarea, [role="button"], header')) return
      if (!(window.getSelection()?.isCollapsed ?? true)) return
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        const next = new Set(selectedRef.current)
        if (!next.delete(id)) next.add(id)
        select(next)
      } else {
        select([id])
      }
    },
    [select]
  )

  /* The drag handler is created before `zoomToItem`, so it reaches it through here. */
  useEffect(() => {
    zoomToItemRef.current = zoomToItem
  }, [zoomToItem])

  const openCanvasMenu = (e: React.MouseEvent): void => {
    const box = e.currentTarget.getBoundingClientRect()
    canvas.refreshCanvases()
    setListMenu({
      x: box.left,
      y: box.bottom + 6,
      label: 'Canvases',
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

  const stackRanks = useMemo(() => cardStackRanks(cards, stack), [cards, stack])

  const displayed = useMemo((): CanvasCard[] => {
    if (gesture?.type === 'drag') {
      const { dx, dy } = dragDelta
      return cards.map((card) =>
        gesture.ids.has(card.id)
          ? { ...card, rect: { ...card.rect, x: card.rect.x + dx, y: card.rect.y + dy } }
          : card
      )
    }
    if (gesture?.type === 'resize' && resizedRect) {
      const moved = new Map(resizeUpdates?.map((update) => [update.id, update.rect]))
      return cards.map((card) => {
        const rect = moved.get(card.id)
        return rect ? { ...card, rect } : card
      })
    }
    return cards
  }, [cards, dragDelta, gesture, resizedRect, resizeUpdates])

  const displayedFrames = useMemo(() => {
    if (gesture?.type === 'drag' && gesture.frameIds.size > 0) {
      const { dx, dy } = dragDelta
      return frames.map((frame) =>
        gesture.frameIds.has(frame.id)
          ? { ...frame, rect: { ...frame.rect, x: frame.rect.x + dx, y: frame.rect.y + dy } }
          : frame
      )
    }
    if (gesture?.type === 'frameResize' && resizedFrameRect) {
      return frames.map((frame) =>
        frame.id === gesture.id ? { ...frame, rect: resizedFrameRect } : frame
      )
    }
    return frames
  }, [dragDelta, frames, gesture, resizedFrameRect])

  // The cards whose history the one selected card would send.
  const pathIds = useMemo((): ReadonlySet<string> => {
    if (selectedIds.size !== 1) return new Set()
    return sessionAncestorIds(cards, [...selectedIds][0])
  }, [cards, selectedIds])

  const outlineRows = useMemo(
    () => (outlineOpen ? canvasOutline({ cards, frames }, turns) : []),
    [cards, frames, outlineOpen, turns]
  )
  const streamingIds = useMemo((): ReadonlySet<string> => {
    if (!outlineOpen) return new Set()
    const live = { turns, streamingTurnIds: canvas.streamingTurnIds }
    return new Set(
      cards.filter((card) => cardContent(card, live).status === 'streaming').map((card) => card.id)
    )
  }, [canvas.streamingTurnIds, cards, outlineOpen, turns])

  const draftParent = useMemo(
    () =>
      draft?.parentId === undefined
        ? undefined
        : displayed.find((card) => card.id === draft.parentId),
    [displayed, draft]
  )

  // A draft kept against its parent follows it as it grows or moves.
  const draftRect = useMemo(() => {
    if (!draft) return null
    if (resizedDraft) return resizedDraft.rect
    return draft.side && draftParent
      ? rectAgainst(draftParent.rect, draft.side, draft.rect)
      : draft.rect
  }, [draft, draftParent, resizedDraft])

  // Held over the composer, a card or a `+` links rather than moves.
  const overDraft =
    draftRect !== null &&
    (gesture?.type === 'extend' ||
      (gesture?.type === 'drag' && cards.some((card) => card.id === gesture.id))) &&
    containsPoint(draftRect, gesture.pointer)

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
    const known = new Set(cards.map((card) => card.id))
    const inHistory = sessionCardIds(cards, draftParent?.id)
    const id = canvas.ask(
      draftRect,
      question,
      draftParent?.id,
      draft?.sourceIds,
      draft?.context?.filter((link) => known.has(link.from) && !inHistory.includes(link.from))
    )
    currentIdRef.current = id
    select([])
    setDraft(null)
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
      sessions: draft.sessions,
      ...(draft.sourceIds ? { sourceIds: draft.sourceIds } : {}),
      ...(draft.context ? { context: draft.context } : {})
    })
  }

  const setDraftContextMode = (id: string, context: CanvasLinkContext): void => {
    setDraft(
      (prev) =>
        prev && {
          ...prev,
          context: prev.context?.map((link) => (link.from === id ? { ...link, context } : link))
        }
    )
  }

  const removeDraftContext = (id: string): void => {
    setDraft(
      (prev) => prev && { ...prev, context: prev.context?.filter((link) => link.from !== id) }
    )
  }

  const startDraftResize = (e: React.PointerEvent): void => {
    if (e.button !== 0 || !draft || !draftRect) return
    const start = pointerInWorld(e)
    claimPress(e)
    setGesture({
      type: 'draftResize',
      side: draftParent ? draft.side : undefined,
      rect: draftRect,
      start,
      pointer: start
    })
  }

  const resizeDraftBy = (dw: number, dh: number): void => {
    if (!draft || !draftRect) return
    const side = draftParent ? draft.side : undefined
    const { rect } = resizeDraftRect(draftRect, side, { dw, dh }, cardRects(displayed), 0)
    setDraft({ ...draft, rect })
    refollow()
  }

  const commitNoteDraft = (text: string): void => {
    if (!noteDraft) return
    setNoteDraft(null)
    if (text.trim() !== '') select([addNote(noteDraft.rect, text)])
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

  const draftOwnContext = useMemo(() => {
    const known = new Set(cards.map((card) => card.id))
    return (draft?.context ?? []).filter((link) => known.has(link.from))
  }, [cards, draft?.context])
  const draftInherited = useMemo(
    () =>
      sessionContextLinks(cards, links, draftParent?.id).filter((link) =>
        draftOwnContext.every((own) => own.from !== link.from)
      ),
    [cards, draftOwnContext, draftParent?.id, links]
  )
  const draftContextSize = useMemo(() => {
    const all = [...draftOwnContext, ...draftInherited]
    if (all.length === 0) return { tokens: 0, clipped: false }
    const history = draftParent ? turnsThroughCard(cards, turns, draftParent.id) : []
    const { items, clipped } = contextExcerpts(cards, turns, all, history, draft?.sourceIds ?? [])
    return {
      tokens: items.reduce((sum, item) => sum + estimateTokens(item.text), 0),
      clipped
    }
  }, [cards, draft?.sourceIds, draftInherited, draftOwnContext, draftParent, turns])
  const draftChips = [
    ...draftOwnContext.map((link) => ({ link, inherited: false })),
    ...draftInherited.map((link) => ({ link, inherited: true }))
  ].flatMap(({ link, inherited }): CanvasDraftContext[] => {
    const card = cards.find((item) => item.id === link.from)
    if (!card) return []
    const content = cardContent(card, canvas)
    return [
      {
        id: link.from,
        label: card.kind === 'note' ? card.text : (content.question ?? content.caption),
        context: card.kind === 'note' ? undefined : link.context,
        inherited
      }
    ]
  })
  const contextStreaming = draftOwnContext.some((link) => {
    const card = cards.find((item) => item.id === link.from)
    return card !== undefined && cardContent(card, canvas).status === 'streaming'
  })
  const pickedIds = useMemo(
    () => new Set(draftOwnContext.map((link) => link.from)),
    [draftOwnContext]
  )
  const draftLinks =
    draftRect === null
      ? []
      : [
          ...draftOwnContext.flatMap((link) => {
            const from = displayed.find((card) => card.id === link.from)
            return from ? [{ id: link.from, from: from.rect, to: draftRect }] : []
          }),
          // Placed away from what it continues, nothing else shows that it does.
          ...(draftParent &&
          !continuationCandidates(draftRect, displayed).some((card) => card.id === draftParent.id)
            ? [{ id: `parent-${draftParent.id}`, from: draftParent.rect, to: draftRect }]
            : [])
        ]

  const drawing =
    gesture?.type === 'draw' ? drawnRect(gesture.what, gesture.start, gesture.end) : null
  const drawsAnswer = gesture?.type === 'draw' && gesture.what === 'answer'
  const drawCaption = placing?.label.length ?? 0
  const drawSessions =
    drawing && drawsAnswer && !placing && !drawing.refusal
      ? continuationCandidates(drawing.rect, cards)
      : []
  const drawContinues =
    gesture?.type === 'draw' && gesture.continues
      ? cards.find((card) => card.id === gesture.continues)
      : undefined
  const drawParent = drawContinues ?? drawSessions.at(0)
  const connectFromId =
    gesture?.type === 'connect' || gesture?.type === 'extend' ? gesture.from : null
  const connectToId = useMemo(() => {
    if (gesture?.type !== 'connect') return null
    const target = cardAtPoint(cards, gesture.pointer, stack)
    return target && target.id !== gesture.from ? target.id : null
  }, [cards, gesture, stack])
  const pendingConnector = useMemo(() => {
    if (drawContinues && drawing) return { from: drawContinues.rect, to: drawing.rect }
    if (gesture?.type === 'extend') {
      const from = cards.find((card) => card.id === gesture.from)
      if (!from) return null
      return {
        from: from.rect,
        to:
          overDraft && draftRect
            ? draftRect
            : { x: gesture.pointer.x, y: gesture.pointer.y, w: 1, h: 1 }
      }
    }
    if (gesture?.type !== 'connect') return null
    const from = cards.find((card) => card.id === gesture.from)
    if (!from) return null
    const to = cards.find((card) => card.id === connectToId)
    return {
      from: from.rect,
      to: to?.rect ?? { x: gesture.pointer.x, y: gesture.pointer.y, w: 1, h: 1 }
    }
  }, [cards, connectToId, draftRect, drawContinues, drawing, gesture, overDraft])
  const continuedId = drawing ? drawParent?.id : draftParent?.id
  const activeGuides =
    gesture?.type === 'drag'
      ? { x: dragDelta.guidesX, y: dragDelta.guidesY }
      : drawing
        ? { x: drawing.guidesX, y: drawing.guidesY }
        : resizedDraft
          ? { x: resizedDraft.guidesX, y: resizedDraft.guidesY }
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
      onContinueStart: handleContinueStart,
      onContextMenu: selection.handleContextMenu,
      onOpenExpansion: handleOpenExpansion,
      onGoToSource: goToSource,
      onCardKeyDown: handleCardKeyDown,
      onCardClick: handleCardClick,
      onCardMenu: handleCardMenu,
      onToggleCollapse: handleToggleCollapse
    }),
    [
      askAnotherExpansion,
      goToSource,
      handleCardClick,
      handleCardKeyDown,
      handleCardMenu,
      handleContinue,
      handleContinueStart,
      handleDelete,
      handleDragStart,
      handleEdit,
      handleOpenExpansion,
      handleRegenerate,
      handleResizeStart,
      handleToggleCollapse,
      selection.handleContextMenu,
      stopCard
    ]
  )

  const surfaceClasses = [
    'canvas-surface',
    animating ? 'is-animating' : '',
    isDrawMode || tool === 'connect' ? 'is-drawing' : '',
    tool === 'hand' || spaceHeld || gesture?.type === 'pan' ? 'is-panning' : '',
    gesture?.type === 'pan' ? 'is-grabbing' : '',
    placing ? 'is-placing' : '',
    overDraft && gesture?.type === 'drag' ? 'is-linking' : ''
  ]
    .filter(Boolean)
    .join(' ')
  const message: CanvasNotice | null =
    notice ?? (selection.notice ? { text: selection.notice } : null)
  const toolHint =
    gesture?.type === 'extend'
      ? EXTEND_HINT
      : gesture?.type === 'draw' && gesture.unheld
        ? SIZE_HINT
        : placing || gesture
          ? undefined
          : TOOL_HINTS[tool]

  const barItems = { cards, frames }
  const chosenCards = cards.filter((card) => selectedIds.has(card.id))
  const collapsibleCards = chosenCards.flatMap((card) => (card.kind === 'note' ? [] : [card]))
  const selectedFrameCount = frames.filter((frame) => selectedIds.has(frame.id)).length
  // Off while a title or label is being typed: it could be sitting right over the field.
  const showBar =
    selectedIds.size > 0 &&
    !gesture &&
    !placing &&
    !noteDraft &&
    !editingFrameId &&
    !editingLinkId &&
    !editingNoteId

  return (
    <div className="canvas-view">
      <div
        ref={surfaceRef}
        className={surfaceClasses}
        onPointerDownCapture={handleSizingPress}
        onPointerDown={handleSurfaceDown}
        onMouseDown={handleSurfaceMouseDown}
        onPointerMove={handleSurfaceMove}
        onPointerUp={handleSurfaceUp}
        onPointerCancel={() => {
          rightDrag.onCancel()
          setGesture(null)
        }}
        onContextMenuCapture={rightDrag.onContextMenuCapture}
        onContextMenu={openPlaneMenu}
      >
        <div ref={worldRef} className={`canvas-world${animating ? ' is-animating' : ''}`}>
          {displayedFrames.map((frame) => (
            <CanvasFrameView
              key={frame.id}
              frame={frame}
              editing={editingFrameId === frame.id}
              selected={liveSelection.has(frame.id)}
              dragging={gesture?.type === 'drag' && gesture.frameIds.has(frame.id)}
              pulsing={pulseId === frame.id}
              dimmed={searchMatches !== null && !searchMatches.has(frame.id)}
              onDragStart={handleDragStart}
              onResizeStart={handleFrameResizeStart}
              onMenu={handleFrameMenu}
              onEdit={setEditingFrameId}
              onRename={renameFrame}
              onZoomTo={zoomToItem}
            />
          ))}
          {displayed.map((card) => {
            const dragging =
              (gesture?.type === 'drag' && gesture.ids.has(card.id)) ||
              (gesture?.type === 'resize' &&
                (gesture.id === card.id ||
                  (resizeUpdates?.some((update) => update.id === card.id) ?? false)))
            const stackLevel = (stackRanks.get(card.id) ?? 0) + 1
            const dimmed = placing
              ? placing.hostId !== card.id
              : searchMatches !== null && !searchMatches.has(card.id)
            if (card.kind === 'note') {
              return (
                <CanvasNoteView
                  key={card.id}
                  card={card}
                  editing={editingNoteId === card.id}
                  selected={liveSelection.has(card.id)}
                  dragging={dragging}
                  stackLevel={stackLevel}
                  pulsing={pulseId === card.id}
                  dimmed={dimmed}
                  continued={
                    connectFromId === card.id ||
                    connectToId === card.id ||
                    pickedIds.has(card.id) ||
                    (tool === 'connect' && !gesture && hoverCardId === card.id)
                  }
                  onDragStart={handleDragStart}
                  onResizeStart={handleResizeStart}
                  onClick={handleCardClick}
                  onKeyDown={handleCardKeyDown}
                  onMenu={handleCardMenu}
                  onEdit={setEditingNoteId}
                  onCommit={updateNote}
                />
              )
            }
            return (
              <CanvasCardView
                key={card.id}
                card={card}
                rect={card.rect}
                {...cardContent(card, canvas)}
                {...actions}
                dragging={dragging}
                handleRight={!continueHandleBlocked(card, 'right', displayed)}
                handleBottom={!continueHandleBlocked(card, 'bottom', displayed)}
                stackLevel={stackLevel}
                pulsing={pulseId === card.id}
                dimmed={dimmed}
                selected={liveSelection.has(card.id)}
                onPath={pathIds.has(card.id)}
                continued={
                  continuedId === card.id ||
                  connectFromId === card.id ||
                  connectToId === card.id ||
                  pickedIds.has(card.id) ||
                  (tool === 'connect' && !gesture && hoverCardId === card.id)
                }
                pulseTermId={pulseTerm?.cardId === card.id ? pulseTerm.expansionId : null}
              />
            )
          })}
          <CanvasLinks
            cards={displayed}
            links={links}
            stackRanks={stackRanks}
            surfaceRef={surfaceRef}
            dragging={gesture?.type === 'drag' || gesture?.type === 'resize'}
            selectedIds={liveSelection}
            editingLinkId={editingLinkId}
            pending={pendingConnector}
            draftLinks={draftLinks}
            onFollow={handleFollowLink}
            onFollowRelation={handleFollowRelation}
            onSelectLink={handleSelectLink}
            onLinkMenu={handleLinkMenu}
            onEditLink={setEditingLinkId}
            onLabelLink={labelLink}
          />
          {draft && draftRect ? (
            <CanvasDraft
              key={draft.key}
              rect={draftRect}
              side={draftParent ? draft.side : undefined}
              resizing={gesture?.type === 'draftResize'}
              sessions={draftSessions}
              parentId={draftParent?.id}
              sourceCount={draft.sourceIds?.length ?? 0}
              context={draftChips}
              contextTokens={draftContextSize.tokens}
              contextClipped={draftContextSize.clipped}
              linkTarget={overDraft}
              waiting={
                parentStatus === 'streaming'
                  ? WAITING_PARENT
                  : parentStatus === 'failed'
                    ? FAILED_PARENT
                    : contextStreaming
                      ? WAITING_CONTEXT
                      : null
              }
              onParentChange={changeDraftParent}
              onActivity={refollow}
              onContextMode={setDraftContextMode}
              onContextRemove={removeDraftContext}
              onResizeStart={startDraftResize}
              onResizeBy={resizeDraftBy}
              onCancel={cancelDraft}
              onSubmit={submitDraft}
            />
          ) : null}
          {noteDraft ? (
            <CanvasNoteDraft
              key={noteDraft.key}
              rect={noteDraft.rect}
              onCancel={() => setNoteDraft(null)}
              onCommit={commitNoteDraft}
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
                {drawsAnswer
                  ? `≈ ${estimateWords(drawing.rect, drawCaption, bodyCharWidth())} words`
                  : ''}
                {!drawsAnswer && gesture.what === 'note' ? 'Note' : ''}
                {!drawsAnswer && gesture.what === 'frame' ? 'Frame' : ''}
                {drawParent
                  ? drawSessions.length > 1
                    ? ` · continues the newest of ${drawSessions.length} sessions`
                    : ' · continues session'
                  : ''}
              </span>
            </div>
          ) : null}
          {gesture?.type === 'marquee' ? (
            <div
              className="canvas-marquee"
              style={(() => {
                const box = rectFromPoints(gesture.start, gesture.end)
                return {
                  transform: `translate(${box.x}px, ${box.y}px)`,
                  width: box.w,
                  height: box.h
                }
              })()}
            />
          ) : null}
        </div>
        {cards.length === 0 && frames.length === 0 && !draft && !noteDraft && !drawing ? (
          <div className="canvas-empty">
            <h2>Draw a rectangle</h2>
            <p>
              Delta writes an answer sized to fit it. Draw against a side to continue the same
              conversation, or anywhere else to start a new one.
            </p>
            <ul className="canvas-empty-keys">
              <li>
                <kbd>N</kbd> type a question
              </li>
              <li>
                <kbd>T</kbd> write a note
              </li>
              <li>
                <kbd>?</kbd> every shortcut
              </li>
            </ul>
          </div>
        ) : null}
      </div>

      <CanvasToolRail
        tool={placing ? 'answer' : tool}
        onTool={chooseTool}
        undoLabel={canvas.undoLabel}
        redoLabel={canvas.redoLabel}
        onUndo={() => handleUndo(undo)}
        onRedo={() => handleUndo(redo)}
        outlineOpen={outlineOpen}
        onToggleOutline={() => (outlineOpen ? setOutlineOpen(false) : openOutline())}
      />

      {outlineOpen ? (
        <CanvasOutline
          rows={outlineRows}
          selectedIds={selectedIds}
          streamingIds={streamingIds}
          focusRequest={outlineFocus}
          onSearchMatches={setSearchMatches}
          onGoTo={goToItem}
          onClose={() => setOutlineOpen(false)}
        />
      ) : null}

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
          title="Start a new, empty canvas"
          disabled={cards.length === 0 && frames.length === 0}
          onClick={canvas.newCanvas}
        >
          New
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

      {minimapOpen && cards.length + frames.length > 0 ? (
        <CanvasMinimap
          ref={minimapRef}
          cards={displayed}
          frames={displayedFrames}
          selectedIds={liveSelection}
          size={surfaceBox}
          viewportRef={viewportRef}
          onNavigate={navigateFromMinimap}
        />
      ) : null}

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
          className={`canvas-tool canvas-tool--icon${minimapOpen ? ' is-toggled' : ''}`}
          aria-label="Map (M)"
          aria-pressed={minimapOpen}
          title="Show or hide the map (M)"
          onClick={toggleMinimap}
        >
          <CanvasIcon name="map" />
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
        {placing || message || toolHint ? (
          <div className="canvas-hint" role="status">
            {message ? (
              <>
                {message.text}
                {message.undoable ? (
                  <button
                    type="button"
                    className="canvas-hint-action"
                    onClick={() => {
                      setNotice(null)
                      handleUndo(undo)
                    }}
                  >
                    Undo
                  </button>
                ) : null}
              </>
            ) : placing ? (
              <>
                Draw a rectangle to size the answer to “{placing.label}”, or click for the default
                size. Esc cancels.
              </>
            ) : (
              toolHint
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
        {showBar ? (
          <CanvasSelectionBar
            count={selectedIds.size}
            colorable={chosenCards.length + selectedFrameCount > 0}
            color={sharedColor(barItems, selectedIds)}
            askable={chosenCards.length + selectedFrameCount > 0}
            connectable={chosenCards.length === 2 && selectedIds.size === 2}
            collapsible={collapsibleCards.length > 0}
            collapsed={collapsibleCards.every((card) => card.collapsedFrom !== undefined)}
            blocks={selectionBlockCount(barItems, selectedIds)}
            linkOnly={
              selectedIds.size === 1 && chosenCards.length === 0 && selectedFrameCount === 0
            }
            onAsk={askAboutSelection}
            onColor={(color) => setColor(selectedIds, color)}
            onAlign={(edge) =>
              applyArrangement('Align', alignSelection(barItems, selectedIds, edge))
            }
            onDistribute={(axis) =>
              applyArrangement('Space evenly', distributeSelection(barItems, selectedIds, axis))
            }
            onTidy={() => applyTidy(tidySelection({ ...barItems, links }, selectedIds))}
            onConnect={() => {
              const [from, to] = chosenCards
              const id = addLink(from.id, to.id)
              if (id !== null) {
                select([id])
                setEditingLinkId(id)
              }
            }}
            onCollapse={() => handleCollapse(selectedIds)}
            onFrame={() => frameSelection(selectedIds)}
            onDuplicate={() => handleDuplicate(selectedIds)}
            onCopy={() => handleCopy(selectedIds)}
            onZoom={zoomToSelection}
            onDelete={() => deleteItems(selectedIds)}
            onLabelLink={() => setEditingLinkId([...selectedIds][0])}
            onReverseLink={() => reverseLink([...selectedIds][0])}
          />
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
