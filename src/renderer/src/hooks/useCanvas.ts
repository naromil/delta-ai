/**
 * Canvas state: one open canvas, its turns and layout, and its streams.
 *
 * It lives in `App` so answers keep streaming while another view is open. A
 * canvas is a conversation record with `source: 'canvas'`, so main and the
 * curator treat it as one. Unlike a chat, its turns are a pool rather than a
 * line: what a request sends is found by walking a card's session.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CanvasCard, CanvasLayout, CanvasRect, CanvasViewport } from '../../../shared/canvas'
import {
  DEFAULT_VIEWPORT,
  cascadeCardIds,
  estimateWords,
  fitCardHeight,
  normalizeCanvasLayout,
  turnsThroughCard,
  withCanvasFit
} from '../../../shared/canvas'
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

export interface CanvasExpandPlacement {
  hostId: string
  rect: CanvasRect
  inset: boolean
}

let nextTurnId = Date.now()

const emptyDoc = (): CanvasDoc => ({
  turns: [],
  layout: { cards: [], viewport: DEFAULT_VIEWPORT }
})

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
  viewport: CanvasViewport
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
  updateCards: (updates: CanvasCardUpdate[]) => void
  requestFit: (id: string) => void
  /** `null` means there was nothing to measure, so the card stays as it is. */
  fitCard: (id: string, contentHeight: number | null) => void
  exportCanvas: () => Promise<{ ok: true; path: string } | { ok: false; error: string }>
  ask: (rect: CanvasRect, question: string, parentId: string | undefined) => void
  expand: (
    turnId: number,
    target: ExpansionTarget,
    prompt: string | undefined,
    placement: CanvasExpandPlacement
  ) => ExpandOutcome
  stopCard: (id: string) => void
  regenerateCard: (id: string) => void
  editCard: (id: string, question: string) => void
  deleteCard: (id: string) => void
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

    if (layout.cards.length === 0) {
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
    (card: CanvasCard, messages: ProviderMessage[]): void => {
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
      const messages = serializeForChat({ turns: path }, 'chat')
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
      return messages && withCanvasFit(messages, estimateWords(rect, captionLength(caption)))
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
    (rect: CanvasRect, question: string, parentId: string | undefined): void => {
      const userTurnId = nextTurnId++
      const turnId = nextTurnId++
      const card: CanvasCard = {
        kind: 'message',
        id: crypto.randomUUID(),
        rect,
        userTurnId,
        turnId,
        ...(parentId !== undefined ? { parentId } : {})
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
        layout: { ...prev.layout, cards: [...prev.layout.cards, card] }
      }))
      sendCard(card)
      requestSave(true)
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
            cards: prev.layout.cards.filter((card) => !doomed.has(card.id))
          }
        }
      })
    },
    [cancelRequests, updateDoc]
  )

  const deleteCard = useCallback(
    (id: string): void => {
      removeCards(cascadeCardIds(docRef.current.layout.cards, id))
      requestSave(true)
    },
    [removeCards, requestSave]
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
      if (!card) return
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
      metaRef.current = nextMeta
      setMeta(nextMeta)
      docRef.current = nextDoc
      setDoc(nextDoc)
      expansionCounterRef.current = maxExpansionId(nextDoc.turns) + 1
    },
    [cancelRequests, flushSave]
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
    viewport: doc.layout.viewport,
    streamingTurnIds,
    fitCardIds,
    ensureLoaded,
    refreshCanvases,
    newCanvas,
    openCanvas,
    deleteCanvas,
    rename,
    setViewport,
    updateCards,
    requestFit,
    fitCard,
    exportCanvas,
    ask,
    expand,
    stopCard,
    regenerateCard,
    editCard,
    deleteCard
  }
}
