/**
 * Canvas state: one open canvas, its turns and layout, and its streams.
 *
 * It lives in `App` so answers keep streaming while another view is open. A
 * canvas is a conversation record with `source: 'canvas'`, so main and the
 * curator treat it as one. Unlike a chat, its turns are a pool rather than a
 * line: what a request sends is found by walking a card's session.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CanvasCard,
  CanvasColor,
  CanvasFrame,
  CanvasLayout,
  CanvasLink,
  CanvasLinkContext,
  CanvasMessageCard,
  CanvasRect,
  CanvasViewport
} from '../../../shared/canvas'
import {
  DEFAULT_VIEWPORT,
  cascadeCardIds,
  estimateWords,
  fitCardHeight,
  normalizeCanvasLayout,
  setCardCollapsed,
  turnsThroughCard,
  withCanvasContext,
  withCanvasFit,
  withoutField,
  withCanvasSources
} from '../../../shared/canvas'
import type { CanvasFrameUpdate } from '../../../shared/canvas-arrange'
import { duplicateSelection } from '../../../shared/canvas-arrange'
import type {
  CanvasPatch,
  CanvasPatchDirection,
  CanvasSnapshot
} from '../../../shared/canvas-history'
import { applyCanvasPatch, diffCanvas } from '../../../shared/canvas-history'
import type { CanvasContextLink } from '../../../shared/canvas-context'
import { requestContext } from '../../../shared/canvas-context'
import { sourceExcerpts } from '../../../shared/canvas-selection'
import type { ConversationMeta, ProviderMessage, Turn } from '../../../shared/conversation'
import {
  CONVERSATION_TITLE_MAX_LENGTH,
  buildConversationTitle,
  serializeForChat
} from '../../../shared/conversation'
import { buildExpandRequest } from '../../../shared/expand-prompt'
import type { ExpansionTarget } from '../../../shared/rich-text'
import {
  applyExpansionChunk,
  expansionMessageInput,
  expansionSubtreeIds,
  finalizeTurns,
  findExpansionInTurns,
  flattenMarkdown,
  insertExpansionInTurns,
  maxExpansionId,
  removeExpansionInTurns,
  restartExpansion
} from '../../../shared/rich-text'
import { isAnchoredRange } from '../lib/markdown'
import { generateRequestId } from './chat/requests'
import type { ExpandOutcome } from './useChatStreaming'

const SAVE_DELAY_MS = 300
const UNTITLED = 'Untitled canvas'
const HISTORY_LIMIT = 100

interface CanvasDoc {
  turns: Turn[]
  layout: CanvasLayout
}

interface CanvasMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  kbFed: boolean
  /** A record exists on disk, so an emptied canvas must be removed from there. */
  persisted: boolean
}

type PendingRequest = { kind: 'send'; turnId: number } | { kind: 'expand'; expansionId: number }

export interface CanvasCardUpdate {
  id: string
  rect: CanvasRect
  inset?: boolean
}

/** What undo or redo did, with the reason when it could not. */
export type CanvasHistoryStep = { ok: true; label: string } | { ok: false; reason: string }

export interface CanvasExpandPlacement {
  hostId: string
  rect: CanvasRect
  inset: boolean
}

let nextTurnId = Date.now()

const emptyDoc = (): CanvasDoc => ({
  turns: [],
  layout: { cards: [], frames: [], links: [], viewport: DEFAULT_VIEWPORT }
})

function snapshotOf({ turns, layout }: CanvasDoc): CanvasSnapshot {
  return { turns, cards: layout.cards, frames: layout.frames, links: layout.links }
}

function newMeta(): CanvasMeta {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    title: UNTITLED,
    createdAt: now,
    updatedAt: now,
    kbFed: false,
    persisted: false
  }
}

function captionLength(text: string): number {
  return flattenMarkdown(text).length
}

function requestBelongsTo(request: PendingRequest, card: CanvasCard): boolean {
  if (card.kind === 'note') return false
  return card.kind === 'message'
    ? request.kind === 'send' && request.turnId === card.turnId
    : request.kind === 'expand' && request.expansionId === card.expansionId
}

export function useCanvas(): {
  loaded: boolean
  canvases: ConversationMeta[]
  canvasId: string
  title: string
  turns: Turn[]
  cards: CanvasCard[]
  frames: CanvasFrame[]
  links: CanvasLink[]
  viewport: CanvasViewport
  /** What undo and redo would do next; null when there is nothing. */
  undoLabel: string | null
  redoLabel: string | null
  /** Assistant turns with a request in flight. */
  streamingTurnIds: ReadonlySet<number>
  /** Cards whose height should be fitted to their answer the next time they are on screen. */
  fitCardIds: ReadonlySet<string>
  ensureLoaded: () => void
  refreshCanvases: () => void
  newCanvas: () => void
  openCanvas: (id: string) => void
  deleteCanvas: () => void
  rename: (title: string) => void
  setViewport: (viewport: CanvasViewport) => void
  /** Moves cards and frames as one undoable step. */
  moveItems: (label: string, cards: CanvasCardUpdate[], frames?: CanvasFrameUpdate[]) => void
  undo: () => CanvasHistoryStep | null
  redo: () => CanvasHistoryStep | null
  addNote: (rect: CanvasRect, text: string) => string
  updateNote: (id: string, text: string) => void
  addFrame: (rect: CanvasRect, title: string) => string
  renameFrame: (id: string, title: string) => void
  addLink: (from: string, to: string) => string | null
  labelLink: (id: string, label: string) => void
  reverseLink: (id: string) => void
  /** What this link sends to the branch it points at; undefined makes it a plain arrow again. */
  setLinkContext: (id: string, context: CanvasLinkContext | undefined) => void
  setColor: (ids: ReadonlySet<string>, color: CanvasColor | undefined) => void
  setCollapsed: (ids: ReadonlySet<string>, collapsed: boolean) => void
  /** Returns the new items' ids; empty when nothing could be copied. */
  duplicate: (ids: ReadonlySet<string>) => string[]
  requestFit: (id: string) => void
  /** `null` means there was nothing to measure, so the card stays as it is. */
  fitCard: (id: string, contentHeight: number | null) => void
  exportCanvas: () => Promise<{ ok: true; path: string } | { ok: false; error: string }>
  /** Returns the new card's id. */
  ask: (
    rect: CanvasRect,
    question: string,
    parentId: string | undefined,
    sources?: readonly string[],
    context?: readonly CanvasContextLink[]
  ) => string
  expand: (
    turnId: number,
    target: ExpansionTarget,
    prompt: string | undefined,
    placement: CanvasExpandPlacement
  ) => ExpandOutcome
  stopCard: (id: string) => void
  regenerateCard: (id: string) => void
  editCard: (id: string, question: string) => void
  /** Removes cards with what depends on them, frames (not what they hold) and links. */
  removeItems: (ids: ReadonlySet<string>) => void
} {
  const [doc, setDoc] = useState<CanvasDoc>(emptyDoc)
  const [loaded, setLoaded] = useState(false)
  const [canvases, setCanvases] = useState<ConversationMeta[]>([])
  const [meta, setMeta] = useState<CanvasMeta>(newMeta)
  const [streamingTurnIds, setStreamingTurnIds] = useState<ReadonlySet<number>>(new Set())
  const [fitCardIds, setFitCardIds] = useState<ReadonlySet<string>>(new Set())

  // Requests start from event handlers and must see the newest state at once.
  const docRef = useRef(doc)
  const metaRef = useRef(meta)
  const requestsRef = useRef(new Map<string, PendingRequest>())
  const expansionCounterRef = useRef(1)
  const saveTimerRef = useRef<number | null>(null)
  const loadStartedRef = useRef(false)
  const undoStackRef = useRef<CanvasPatch[]>([])
  const redoStackRef = useRef<CanvasPatch[]>([])
  const [historyLabels, setHistoryLabels] = useState<{
    undo: string | null
    redo: string | null
  }>({ undo: null, redo: null })

  const updateDoc = useCallback((change: (prev: CanvasDoc) => CanvasDoc): void => {
    docRef.current = change(docRef.current)
    setDoc(docRef.current)
  }, [])

  const updateMeta = useCallback((patch: Partial<CanvasMeta>): void => {
    metaRef.current = { ...metaRef.current, ...patch }
    setMeta(metaRef.current)
  }, [])

  const refreshCanvases = useCallback((): void => {
    void window.api.listCanvases().then(setCanvases, (err: unknown) => {
      console.warn('Failed to list canvases:', err)
    })
  }, [])

  /* ---- Persistence ---- */

  const flushSave = useCallback((): Promise<void> => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null
    const current = metaRef.current
    const { turns, layout } = docRef.current
    const onFailure = (err: unknown): void => console.warn('Failed to save canvas:', err)

    if (layout.cards.length === 0 && layout.frames.length === 0) {
      if (!current.persisted) return Promise.resolve()
      updateMeta({ persisted: false })
      return window.api.deleteConversation(current.id).then(refreshCanvases, onFailure)
    }
    const firstSave = !current.persisted
    updateMeta({ persisted: true })
    return window.api
      .saveConversation({
        id: current.id,
        title: current.title,
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
        source: 'canvas',
        kbFed: current.kbFed,
        state: { turns: finalizeTurns(turns), canvas: layout }
      })
      .then(() => {
        if (firstSave) refreshCanvases()
      }, onFailure)
  }, [refreshCanvases, updateMeta])

  /** `touchContent` is for content only: moving or panning never reorders the canvas list. */
  const requestSave = useCallback(
    (touchContent: boolean): void => {
      if (touchContent) updateMeta({ updatedAt: new Date().toISOString(), kbFed: false })
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = window.setTimeout(() => void flushSave(), SAVE_DELAY_MS)
    },
    [flushSave, updateMeta]
  )

  /* ---- Undo and redo ---- */

  const syncHistory = useCallback((): void => {
    setHistoryLabels({
      undo: undoStackRef.current.at(-1)?.label ?? null,
      redo: redoStackRef.current.at(-1)?.label ?? null
    })
  }, [])

  /** Runs one user action and remembers what it changed, so it can be taken back. */
  const recorded = useCallback(
    (label: string, action: () => void): void => {
      const before = snapshotOf(docRef.current)
      action()
      const patch = diffCanvas(label, before, snapshotOf(docRef.current))
      if (!patch) return
      undoStackRef.current = [...undoStackRef.current, patch].slice(-HISTORY_LIMIT)
      redoStackRef.current = []
      syncHistory()
    },
    [syncHistory]
  )

  const stepHistory = useCallback(
    (direction: CanvasPatchDirection): CanvasHistoryStep | null => {
      const undoing = direction === 'undo'
      const from = undoing ? undoStackRef : redoStackRef
      const to = undoing ? redoStackRef : undoStackRef
      const patch = from.current.at(-1)
      if (!patch) return null
      const result = applyCanvasPatch(snapshotOf(docRef.current), patch, direction)
      if (!result.ok) {
        if (result.reason === 'blocked') {
          return { ok: false, reason: 'Something is in the way now. Move it, then try again.' }
        }
        // That answer has moved on, so this step can never apply again.
        from.current = from.current.slice(0, -1)
        syncHistory()
        return { ok: false, reason: `“${patch.label}” can no longer be taken back.` }
      }
      from.current = from.current.slice(0, -1)
      to.current = [...to.current, patch]
      const { turns, cards, frames, links } = result.snapshot
      updateDoc((prev) => ({ turns, layout: { ...prev.layout, cards, frames, links } }))
      requestSave(patch.turns.length > 0)
      syncHistory()
      return { ok: true, label: patch.label }
    },
    [requestSave, syncHistory, updateDoc]
  )

  const undo = useCallback(() => stepHistory('undo'), [stepHistory])
  const redo = useCallback(() => stepHistory('redo'), [stepHistory])

  /* ---- Requests ---- */

  const syncStreaming = useCallback((): void => {
    const ids = new Set<number>()
    for (const request of requestsRef.current.values()) {
      if (request.kind === 'send') ids.add(request.turnId)
    }
    setStreamingTurnIds(ids)
  }, [])

  const cancelRequests = useCallback(
    (matches: (request: PendingRequest) => boolean): void => {
      for (const [requestId, request] of [...requestsRef.current]) {
        if (!matches(request)) continue
        // Forgotten first, so a late chunk cannot land on what is being removed.
        requestsRef.current.delete(requestId)
        window.api.chatCancel(requestId)
      }
      syncStreaming()
    },
    [syncStreaming]
  )

  const startSend = useCallback(
    (card: CanvasMessageCard, messages: ProviderMessage[]): void => {
      const requestId = generateRequestId()
      requestsRef.current.set(requestId, { kind: 'send', turnId: card.turnId })
      syncStreaming()
      window.api.chatSend({ messages, requestId, role: 'chat' })
    },
    [syncStreaming]
  )

  const sendCard = useCallback(
    (card: CanvasCard): void => {
      if (card.kind !== 'message') return
      const { turns, layout } = docRef.current
      const question = turns.find((turn) => turn.id === card.userTurnId)
      // The answer being written is blank, which serialization leaves out.
      const path = turnsThroughCard(layout.cards, turns, card.id)
      const sources = sourceExcerpts(layout.cards, turns, card.sources ?? [])
      const context = requestContext(layout.cards, layout.links, turns, card.id, card.sources ?? [])
      const messages = withCanvasContext(
        withCanvasSources(serializeForChat({ turns: path }, 'chat'), sources),
        context
      )
      const words = estimateWords(card.rect, captionLength(question?.content ?? ''))
      startSend(card, withCanvasFit(messages, words))
    },
    [startSend]
  )

  const expansionMessages = useCallback(
    (
      turn: Turn,
      target: ExpansionTarget,
      prompt: string | undefined,
      rect: CanvasRect,
      caption: string
    ): ProviderMessage[] | null => {
      const { turns, layout } = docRef.current
      const message = layout.cards.find(
        (card) => card.kind === 'message' && card.turnId === turn.id
      )
      if (!message) return null
      const messages = buildExpandRequest(
        { turns: turnsThroughCard(layout.cards, turns, message.id) },
        turn,
        target.parentExpansionId,
        target,
        'chat',
        prompt
      )
      if (!messages) return null
      const context = requestContext(layout.cards, layout.links, turns, message.id)
      return withCanvasFit(
        withCanvasContext(messages, context),
        estimateWords(rect, captionLength(caption))
      )
    },
    []
  )

  const expand = useCallback(
    (
      turnId: number,
      target: ExpansionTarget,
      prompt: string | undefined,
      placement: CanvasExpandPlacement
    ): ExpandOutcome => {
      const turn = docRef.current.turns.find((item) => item.id === turnId)
      if (!turn) return { ok: false, reason: 'turn-not-found' }
      const input = expansionMessageInput(turn, target.parentExpansionId, target)
      if (!input) return { ok: false, reason: 'out-of-bounds' }
      if (!isAnchoredRange(input.answer, target)) return { ok: false, reason: 'not-anchored' }

      const expansionId = expansionCounterRef.current
      const insertion = insertExpansionInTurns(
        docRef.current.turns,
        turnId,
        target,
        expansionId,
        prompt
      )
      if (!insertion.ok) return { ok: false, reason: insertion.reason }
      const messages = expansionMessages(turn, target, prompt, placement.rect, input.selection)
      if (!messages) return { ok: false, reason: 'turn-not-found' }

      expansionCounterRef.current += 1
      updateDoc((prev) => ({
        turns: insertion.turns,
        layout: {
          ...prev.layout,
          cards: [
            ...prev.layout.cards,
            {
              kind: 'expansion',
              id: crypto.randomUUID(),
              rect: placement.rect,
              turnId,
              expansionId,
              hostId: placement.hostId,
              inset: placement.inset
            }
          ]
        }
      }))
      const requestId = generateRequestId()
      requestsRef.current.set(requestId, { kind: 'expand', expansionId })
      window.api.chatExpand({ messages, requestId, role: 'chat' })
      requestSave(true)
      return { ok: true }
    },
    [expansionMessages, requestSave, updateDoc]
  )

  const ask = useCallback(
    (
      rect: CanvasRect,
      question: string,
      parentId: string | undefined,
      sources: readonly string[] = [],
      context: readonly CanvasContextLink[] = []
    ): string => {
      const userTurnId = nextTurnId++
      const turnId = nextTurnId++
      const card: CanvasCard = {
        kind: 'message',
        id: crypto.randomUUID(),
        rect,
        userTurnId,
        turnId,
        ...(parentId !== undefined ? { parentId } : {}),
        ...(sources.length > 0 ? { sources: [...sources] } : {})
      }
      if (metaRef.current.title === UNTITLED) {
        updateMeta({ title: buildConversationTitle(question) })
      }
      updateDoc((prev) => ({
        turns: [
          ...prev.turns,
          { id: userTurnId, role: 'user', content: question, expansions: [] },
          { id: turnId, role: 'assistant', content: '', expansions: [] }
        ],
        layout: {
          ...prev.layout,
          cards: [...prev.layout.cards, card],
          links: [
            ...prev.layout.links,
            ...context.map((link): CanvasLink => ({
              ...link,
              id: crypto.randomUUID(),
              to: card.id
            }))
          ]
        }
      }))
      sendCard(card)
      requestSave(true)
      return card.id
    },
    [requestSave, sendCard, updateDoc, updateMeta]
  )

  const stopCard = useCallback((id: string): void => {
    const card = docRef.current.layout.cards.find((item) => item.id === id)
    if (!card) return
    // Stays in the book: main answers with the partial text, which settles it.
    for (const [requestId, request] of requestsRef.current) {
      if (requestBelongsTo(request, card)) window.api.chatCancel(requestId)
    }
  }, [])

  const removeCards = useCallback(
    (doomed: ReadonlySet<string>): void => {
      const { turns, layout } = docRef.current
      const doomedCards = layout.cards.filter((card) => doomed.has(card.id))
      const doomedTurns = new Set<number>()
      const doomedExpansions = new Set<number>()
      for (const card of doomedCards) {
        if (card.kind === 'note') continue
        if (card.kind === 'message') {
          doomedTurns.add(card.userTurnId)
          doomedTurns.add(card.turnId)
          continue
        }
        const location = findExpansionInTurns(turns, card.expansionId)
        if (location) {
          for (const nodeId of expansionSubtreeIds(location.node)) doomedExpansions.add(nodeId)
        }
      }
      cancelRequests((request) =>
        request.kind === 'send'
          ? doomedTurns.has(request.turnId)
          : doomedExpansions.has(request.expansionId)
      )
      updateDoc((prev) => {
        let nextTurns = prev.turns.filter((turn) => !doomedTurns.has(turn.id))
        for (const card of doomedCards) {
          if (card.kind === 'expansion') {
            nextTurns = removeExpansionInTurns(nextTurns, card.expansionId)
          }
        }
        return {
          turns: nextTurns,
          layout: {
            ...prev.layout,
            cards: prev.layout.cards.filter((card) => !doomed.has(card.id)),
            links: prev.layout.links.filter(
              (link) => !doomed.has(link.from) && !doomed.has(link.to)
            )
          }
        }
      })
    },
    [cancelRequests, updateDoc]
  )

  const removeItems = useCallback(
    (ids: ReadonlySet<string>): void => {
      const { cards } = docRef.current.layout
      const doomed = new Set<string>()
      for (const card of cards) {
        if (ids.has(card.id)) {
          for (const id of cascadeCardIds(cards, card.id)) doomed.add(id)
        }
      }
      recorded('Delete', () => {
        if (doomed.size > 0) removeCards(doomed)
        updateDoc((prev) => ({
          ...prev,
          layout: {
            ...prev.layout,
            frames: prev.layout.frames.filter((frame) => !ids.has(frame.id)),
            links: prev.layout.links.filter((link) => !ids.has(link.id))
          }
        }))
      })
      requestSave(doomed.size > 0)
    },
    [recorded, removeCards, requestSave, updateDoc]
  )

  /**
   * A fresh answer sized by the card as it is now, for Retry and Regenerate alike.
   * What depends on the old answer goes first: expansions are anchored in its text
   * and continuations were written after it.
   */
  const regenerateCard = useCallback(
    (id: string): void => {
      const { turns, layout } = docRef.current
      const card = layout.cards.find((item) => item.id === id)
      if (!card || card.kind === 'note') return
      const dependents = cascadeCardIds(layout.cards, id)
      dependents.delete(id)

      if (card.kind === 'message') {
        removeCards(dependents)
        cancelRequests((request) => requestBelongsTo(request, card))
        updateDoc((prev) => ({
          ...prev,
          turns: prev.turns.map((turn) => {
            if (turn.id !== card.turnId) return turn
            return { id: turn.id, role: turn.role, content: '', expansions: [] }
          })
        }))
        sendCard(card)
      } else {
        const location = findExpansionInTurns(turns, card.expansionId)
        if (!location) return
        const target: ExpansionTarget = {
          start: location.node.start,
          end: location.node.end,
          ...(location.parent ? { parentExpansionId: location.parent.id } : {})
        }
        const messages = expansionMessages(
          location.turn,
          target,
          location.node.prompt,
          card.rect,
          location.node.originalText
        )
        if (!messages) return
        removeCards(dependents)
        cancelRequests((request) => requestBelongsTo(request, card))
        updateDoc((prev) => ({ ...prev, turns: restartExpansion(prev.turns, card.expansionId) }))
        const requestId = generateRequestId()
        requestsRef.current.set(requestId, { kind: 'expand', expansionId: card.expansionId })
        window.api.chatExpand({ messages, requestId, role: 'chat' })
      }
      requestSave(true)
    },
    [cancelRequests, expansionMessages, removeCards, requestSave, sendCard, updateDoc]
  )

  const editCard = useCallback(
    (id: string, question: string): void => {
      const card = docRef.current.layout.cards.find((item) => item.id === id)
      if (card?.kind !== 'message') return
      updateDoc((prev) => ({
        ...prev,
        turns: prev.turns.map((turn) =>
          turn.id === card.userTurnId ? { ...turn, content: question } : turn
        )
      }))
      regenerateCard(id)
    },
    [regenerateCard, updateDoc]
  )

  /* ---- Layout ---- */

  const setViewport = useCallback(
    (viewport: CanvasViewport): void => {
      updateDoc((prev) => ({ ...prev, layout: { ...prev.layout, viewport } }))
      requestSave(false)
    },
    [requestSave, updateDoc]
  )

  const updateCards = useCallback(
    (updates: CanvasCardUpdate[]): void => {
      const byId = new Map(updates.map((update) => [update.id, update]))
      updateDoc((prev) => ({
        ...prev,
        layout: {
          ...prev.layout,
          cards: prev.layout.cards.map((card) => {
            const update = byId.get(card.id)
            if (!update) return card
            return card.kind === 'expansion' && update.inset !== undefined
              ? { ...card, rect: update.rect, inset: update.inset }
              : { ...card, rect: update.rect }
          })
        }
      }))
      requestSave(false)
    },
    [requestSave, updateDoc]
  )

  const moveItems = useCallback(
    (label: string, cards: CanvasCardUpdate[], frames: CanvasFrameUpdate[] = []): void => {
      const rects = new Map(frames.map((frame) => [frame.id, frame.rect]))
      recorded(label, () => {
        updateCards(cards)
        if (rects.size === 0) return
        updateDoc((prev) => ({
          ...prev,
          layout: {
            ...prev.layout,
            frames: prev.layout.frames.map((frame) => {
              const rect = rects.get(frame.id)
              return rect ? { ...frame, rect } : frame
            })
          }
        }))
      })
    },
    [recorded, updateCards, updateDoc]
  )

  /** A change to the layout alone: never a change of content, so recents keep their order. */
  const editLayout = useCallback(
    (label: string, change: (layout: CanvasLayout) => CanvasLayout): void => {
      recorded(label, () => {
        updateDoc((prev) => ({ ...prev, layout: change(prev.layout) }))
      })
      requestSave(false)
    },
    [recorded, requestSave, updateDoc]
  )

  const addNote = useCallback(
    (rect: CanvasRect, text: string): string => {
      const id = crypto.randomUUID()
      editLayout('Add note', (layout) => ({
        ...layout,
        cards: [...layout.cards, { kind: 'note', id, rect, text }]
      }))
      return id
    },
    [editLayout]
  )

  const updateNote = useCallback(
    (id: string, text: string): void => {
      editLayout('Edit note', (layout) => ({
        ...layout,
        cards: layout.cards.map((card) =>
          card.id === id && card.kind === 'note' && card.text !== text ? { ...card, text } : card
        )
      }))
    },
    [editLayout]
  )

  const addFrame = useCallback(
    (rect: CanvasRect, title: string): string => {
      const id = crypto.randomUUID()
      editLayout('Add frame', (layout) => ({
        ...layout,
        frames: [...layout.frames, { id, rect, title }]
      }))
      return id
    },
    [editLayout]
  )

  const renameFrame = useCallback(
    (id: string, title: string): void => {
      editLayout('Rename frame', (layout) => ({
        ...layout,
        frames: layout.frames.map((frame) =>
          frame.id === id && frame.title !== title ? { ...frame, title } : frame
        )
      }))
    },
    [editLayout]
  )

  const addLink = useCallback(
    (from: string, to: string): string | null => {
      const { cards, links } = docRef.current.layout
      const known = (id: string): boolean => cards.some((card) => card.id === id)
      if (from === to || !known(from) || !known(to)) return null
      const existing = links.find((link) => link.from === from && link.to === to)
      if (existing) return existing.id
      const id = crypto.randomUUID()
      editLayout('Connect', (layout) => ({
        ...layout,
        links: [...layout.links, { id, from, to }]
      }))
      return id
    },
    [editLayout]
  )

  const editLink = useCallback(
    (label: string, id: string, change: (link: CanvasLink) => CanvasLink): void => {
      editLayout(label, (layout) => ({
        ...layout,
        links: layout.links.map((link) => (link.id === id ? change(link) : link))
      }))
    },
    [editLayout]
  )

  const labelLink = useCallback(
    (id: string, label: string): void => {
      const text = label.trim()
      editLink('Label connection', id, (link) => {
        if ((link.label ?? '') === text) return link
        return text === '' ? withoutField(link, 'label') : { ...link, label: text }
      })
    },
    [editLink]
  )

  const reverseLink = useCallback(
    (id: string): void => {
      editLink('Reverse connection', id, (link) => ({ ...link, from: link.to, to: link.from }))
    },
    [editLink]
  )

  const setLinkContext = useCallback(
    (id: string, context: CanvasLinkContext | undefined): void => {
      editLink(context ? 'Send context' : 'Stop sending context', id, (link) => {
        if (link.context === context) return link
        return context ? { ...link, context } : withoutField(link, 'context')
      })
    },
    [editLink]
  )

  const setColor = useCallback(
    (ids: ReadonlySet<string>, color: CanvasColor | undefined): void => {
      const paint = <T extends { id: string; color?: CanvasColor }>(item: T): T => {
        if (!ids.has(item.id) || item.color === color) return item
        return color === undefined ? withoutField(item, 'color') : { ...item, color }
      }
      editLayout('Colour', (layout) => ({
        ...layout,
        cards: layout.cards.map(paint),
        frames: layout.frames.map(paint)
      }))
    },
    [editLayout]
  )

  const setCollapsed = useCallback(
    (ids: ReadonlySet<string>, collapsed: boolean): void => {
      editLayout(collapsed ? 'Collapse' : 'Expand', (layout) => ({
        ...layout,
        cards: [...ids].reduce((cards, id) => setCardCollapsed(cards, id, collapsed), layout.cards)
      }))
    },
    [editLayout]
  )

  const duplicate = useCallback(
    (ids: ReadonlySet<string>): string[] => {
      const { turns, layout } = docRef.current
      const copy = duplicateSelection(layout, turns, ids, {
        newId: () => crypto.randomUUID(),
        newTurnId: () => nextTurnId++,
        streamingTurnIds: new Set(
          [...requestsRef.current.values()].flatMap((request) =>
            request.kind === 'send' ? [request.turnId] : []
          )
        )
      })
      if (!copy) return []
      recorded('Duplicate', () => {
        updateDoc((prev) => ({
          turns: [...prev.turns, ...copy.turns],
          layout: {
            ...prev.layout,
            cards: [...prev.layout.cards, ...copy.cards],
            frames: [...prev.layout.frames, ...copy.frames],
            links: [...prev.layout.links, ...copy.links]
          }
        }))
      })
      requestSave(copy.turns.length > 0)
      return copy.ids
    },
    [recorded, requestSave, updateDoc]
  )

  const requestFit = useCallback((id: string): void => {
    setFitCardIds((prev) => new Set(prev).add(id))
  }, [])

  const fitCard = useCallback(
    (id: string, contentHeight: number | null): void => {
      setFitCardIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      if (contentHeight === null) return
      const updates = fitCardHeight(docRef.current.layout.cards, id, contentHeight)
      if (updates.length > 0) updateCards(updates)
    },
    [updateCards]
  )

  const exportCanvas = useCallback(async (): ReturnType<typeof window.api.exportConversation> => {
    // Main reads the record from disk, so the newest state has to be there first.
    await flushSave()
    return window.api.exportConversation(metaRef.current.id)
  }, [flushSave])

  const rename = useCallback(
    (title: string): void => {
      const next = title.trim().slice(0, CONVERSATION_TITLE_MAX_LENGTH)
      if (next === '' || next === metaRef.current.title) return
      updateMeta({ title: next })
      requestSave(false)
    },
    [requestSave, updateMeta]
  )

  /* ---- Opening canvases ---- */

  const replaceDoc = useCallback(
    (nextDoc: CanvasDoc, nextMeta: CanvasMeta): void => {
      if (saveTimerRef.current !== null) void flushSave()
      cancelRequests(() => true)
      setFitCardIds(new Set())
      undoStackRef.current = []
      redoStackRef.current = []
      syncHistory()
      metaRef.current = nextMeta
      setMeta(nextMeta)
      docRef.current = nextDoc
      setDoc(nextDoc)
      expansionCounterRef.current = maxExpansionId(nextDoc.turns) + 1
    },
    [cancelRequests, flushSave, syncHistory]
  )

  const newCanvas = useCallback((): void => {
    replaceDoc(emptyDoc(), newMeta())
    refreshCanvases()
  }, [refreshCanvases, replaceDoc])

  const openCanvas = useCallback(
    (id: string): void => {
      void window.api.loadConversation(id).then((record) => {
        if (!record || record.source !== 'canvas') {
          refreshCanvases()
          return
        }
        const turns = finalizeTurns(record.state.turns)
        replaceDoc(
          { turns, layout: normalizeCanvasLayout(record.state.canvas, turns) },
          {
            id: record.id,
            title: record.title,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            kbFed: record.kbFed,
            persisted: true
          }
        )
        setLoaded(true)
      })
    },
    [refreshCanvases, replaceDoc]
  )

  const deleteCanvas = useCallback((): void => {
    const { id, persisted } = metaRef.current
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null
    replaceDoc(emptyDoc(), newMeta())
    if (persisted) void window.api.deleteConversation(id).then(refreshCanvases)
  }, [refreshCanvases, replaceDoc])

  const ensureLoaded = useCallback((): void => {
    if (loadStartedRef.current) return
    loadStartedRef.current = true
    void window.api
      .listCanvases()
      .then((list) => {
        setCanvases(list)
        if (list.length > 0) openCanvas(list[0].id)
        else setLoaded(true)
      })
      .catch((err: unknown) => {
        console.warn('Failed to load canvases:', err)
        setLoaded(true)
      })
  }, [openCanvas])

  /* ---- Streaming ---- */

  useEffect(() => {
    const settle = (requestId: string): void => {
      requestsRef.current.delete(requestId)
      syncStreaming()
      requestSave(true)
    }
    const fitAnswered = (matches: (card: CanvasCard) => boolean): void => {
      const card = docRef.current.layout.cards.find(matches)
      if (card) requestFit(card.id)
    }
    const editTurn = (turnId: number, change: (turn: Turn) => Turn): void => {
      updateDoc((prev) => ({
        ...prev,
        turns: prev.turns.map((turn) => (turn.id === turnId ? change(turn) : turn))
      }))
    }

    const unsubs = [
      window.api.chatOnChunk(({ requestId, delta }) => {
        const request = requestsRef.current.get(requestId)
        if (request?.kind !== 'send') return
        editTurn(request.turnId, (turn) => ({ ...turn, content: turn.content + delta }))
      }),
      window.api.chatOnResponse(({ requestId, text, cancelled }) => {
        const request = requestsRef.current.get(requestId)
        if (request?.kind !== 'send') return
        editTurn(request.turnId, (turn) => ({ ...turn, content: text }))
        settle(requestId)
        // A stopped answer is not what the rectangle was for, so it keeps its size.
        if (!cancelled && text.trim() !== '') {
          fitAnswered((card) => card.kind === 'message' && card.turnId === request.turnId)
        }
      }),
      window.api.chatOnError(({ requestId, error }) => {
        const request = requestsRef.current.get(requestId)
        if (request?.kind !== 'send') return
        editTurn(request.turnId, (turn) => ({ ...turn, content: error, error: true }))
        settle(requestId)
      }),
      window.api.chatOnExpandChunk((data) => {
        const request = requestsRef.current.get(data.requestId)
        if (request?.kind !== 'expand') return
        const { delta, text, done, error, cancelled } = data
        updateDoc((prev) => ({
          ...prev,
          turns: applyExpansionChunk(prev.turns, request.expansionId, {
            ...(delta !== undefined ? { delta } : {}),
            ...(text !== undefined ? { text } : {}),
            ...(done !== undefined ? { done } : {}),
            ...(error !== undefined ? { error } : {})
          })
        }))
        if (error !== undefined || done) settle(data.requestId)
        if (done && error === undefined && !cancelled) {
          fitAnswered(
            (card) => card.kind === 'expansion' && card.expansionId === request.expansionId
          )
        }
      })
    ]
    return () => {
      for (const unsub of unsubs) unsub()
    }
  }, [requestFit, requestSave, syncStreaming, updateDoc])

  return {
    loaded,
    canvases,
    canvasId: meta.id,
    title: meta.title,
    turns: doc.turns,
    cards: doc.layout.cards,
    frames: doc.layout.frames,
    links: doc.layout.links,
    viewport: doc.layout.viewport,
    undoLabel: historyLabels.undo,
    redoLabel: historyLabels.redo,
    streamingTurnIds,
    fitCardIds,
    ensureLoaded,
    refreshCanvases,
    newCanvas,
    openCanvas,
    deleteCanvas,
    rename,
    setViewport,
    moveItems,
    undo,
    redo,
    addNote,
    updateNote,
    addFrame,
    renameFrame,
    addLink,
    labelLink,
    reverseLink,
    setLinkContext,
    setColor,
    setCollapsed,
    duplicate,
    requestFit,
    fitCard,
    exportCanvas,
    ask,
    expand,
    stopCard,
    regenerateCard,
    editCard,
    removeItems
  }
}
