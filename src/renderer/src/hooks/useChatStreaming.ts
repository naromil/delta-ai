import { useState, useRef, useCallback, useEffect } from 'react'
import type {
  ConversationState,
  Turn,
  ConversationRecord,
  ProviderMessage
} from '../../../shared/conversation'
import {
  serializeForChat,
  buildConversationTitle,
  persistableTurns
} from '../../../shared/conversation'
import type { ExpansionChunk, ExpansionTarget } from '../../../shared/rich-text'
import {
  applyExpansionChunk,
  expansionMessageInput,
  finalizeTurns,
  findExpansionInTurns,
  insertExpansionInTurns,
  maxExpansionId,
  removeExpansionInTurns,
  setExpansionFolded,
  updateExpansion
} from '../../../shared/rich-text'
import { isAnchoredRange } from '../lib/markdown'
import { getSystemPrompt } from '../../../shared/prompts'
import { buildExpandMessages } from '../../../shared/expand-prompt'

let nextTurnId = Date.now()

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/** Why an expand request was refused; the UI surfaces this instead of silence. */
export type ExpandOutcome = { ok: true } | { ok: false; reason: string }

interface ConversationMeta {
  id: string
  title: string
  createdAt: string
  /** Last *content* change; fold/dismiss never move this. */
  updatedAt: string
  kbFed: boolean
}

function saveConversationState(
  state: ConversationState,
  role: 'chat' | 'lookup',
  meta: ConversationMeta
): Promise<void> | undefined {
  const turns = finalizeTurns(persistableTurns(state.turns))
  if (turns.length === 0 || turns.every((turn) => turn.content.trim() === '')) return undefined
  const record: ConversationRecord = {
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    source: role === 'lookup' ? 'lookup' : 'chat',
    state: { ...state, turns },
    kbFed: meta.kbFed
  }
  return window.api.saveConversation(record).catch((err: unknown) => {
    console.warn('Failed to save conversation:', err)
  })
}

interface PendingRequest {
  kind: 'send' | 'expand'
  turnId: number
  expansionId?: number
}

interface SaveRequest {
  pending: boolean
  touchContent: boolean
}

interface UseChatStreamingOptions {
  role?: 'chat' | 'lookup'
  initial?: Partial<ConversationState>
  onGrown?: () => void
  onReplaceConversation?: () => void
}

export function useChatStreaming(options?: UseChatStreamingOptions): {
  state: ConversationState
  loading: boolean
  contextReady: boolean
  conversationId: string | null
  conversationTitle: string
  send: (content: string) => void
  stop: () => void
  retry: (turnId: number) => void
  expand: (turnId: number, target: ExpansionTarget, prompt?: string) => ExpandOutcome
  retryExpansion: (expansionId: number) => void
  dismissExpansion: (expansionId: number) => void
  fold: (id: number) => void
  unfold: (id: number) => void
  newChat: () => void
  loadConversation: (id: string) => Promise<void>
  setState: React.Dispatch<React.SetStateAction<ConversationState>>
} {
  const role = options?.role ?? 'chat'
  const [state, setState] = useState<ConversationState>({
    context: options?.initial?.context ?? '',
    systemNote: options?.initial?.systemNote ?? '',
    turns: options?.initial?.turns ?? []
  })
  const [loading, setLoading] = useState(false)
  const [contextReady, setContextReady] = useState(role !== 'lookup')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [conversationTitle, setConversationTitle] = useState('')
  const pendingRef = useRef<Map<string, PendingRequest>>(new Map())
  const activeRequestRef = useRef<string | null>(null)
  const expansionIdCounterRef = useRef(1)
  const hasSentRef = useRef(false)
  const conversationMetaRef = useRef<ConversationMeta | null>(null)
  const saveRequestRef = useRef<SaveRequest>({ pending: false, touchContent: false })
  const stateRef = useRef<ConversationState>({
    context: options?.initial?.context ?? '',
    systemNote: options?.initial?.systemNote ?? '',
    turns: options?.initial?.turns ?? []
  })

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const saveCurrentState = useCallback(
    (snapshot: ConversationState, touchContent: boolean): void => {
      const meta = conversationMetaRef.current
      if (!meta) return
      if (touchContent) meta.updatedAt = new Date().toISOString()
      void saveConversationState(snapshot, role, meta)
    },
    [role]
  )

  /**
   * Saves are derived from committed state: the flag is set here and the
   * effect below flushes the newest committed snapshot. No IPC happens inside
   * a `setState` updater (StrictMode double-invokes those).
   */
  const requestSave = useCallback((touchContent: boolean): void => {
    saveRequestRef.current.pending = true
    saveRequestRef.current.touchContent = saveRequestRef.current.touchContent || touchContent
  }, [])

  useEffect(() => {
    const request = saveRequestRef.current
    if (!request.pending) return
    request.pending = false
    const touchContent = request.touchContent
    request.touchContent = false
    saveCurrentState(state, touchContent)
  }, [state, saveCurrentState])

  useEffect(() => {
    const unsubs: Array<() => void> = []

    unsubs.push(
      window.api.chatOnChunk((data) => {
        const pending = pendingRef.current.get(data.requestId)
        if (!pending || pending.kind !== 'send') return

        setState((prev) => {
          const turns = [...prev.turns]
          const turnIdx = turns.findIndex((t) => t.id === pending.turnId)
          if (turnIdx < 0) return prev
          turns[turnIdx] = { ...turns[turnIdx], content: data.text }
          return { ...prev, turns }
        })
      })
    )

    unsubs.push(
      window.api.chatOnResponse((data) => {
        const pending = pendingRef.current.get(data.requestId)
        if (!pending || pending.kind !== 'send') return

        setState((prev) => {
          const turns = [...prev.turns]
          const turnIdx = turns.findIndex((t) => t.id === pending.turnId)
          if (turnIdx < 0) return prev
          // Stopping before the first token should not leave a phantom empty turn.
          if (data.cancelled && data.text.trim() === '') {
            return { ...prev, turns: turns.filter((t) => t.id !== pending.turnId) }
          }
          turns[turnIdx] = { ...turns[turnIdx], content: data.text }
          return { ...prev, turns }
        })
        pendingRef.current.delete(data.requestId)
        if (activeRequestRef.current === data.requestId) activeRequestRef.current = null
        setLoading(false)
        requestSave(true)
      })
    )

    unsubs.push(
      window.api.chatOnError((data) => {
        const pending = pendingRef.current.get(data.requestId)
        if (!pending || pending.kind !== 'send') return

        setState((prev) => {
          const turns = [...prev.turns]
          const turnIdx = turns.findIndex((t) => t.id === pending.turnId)
          if (turnIdx < 0) return prev
          turns[turnIdx] = { ...turns[turnIdx], content: data.error, error: true }
          return { ...prev, turns }
        })
        pendingRef.current.delete(data.requestId)
        if (activeRequestRef.current === data.requestId) activeRequestRef.current = null
        setLoading(false)
        // Keep the failure on disk so Retry survives a reload.
        requestSave(true)
      })
    )

    unsubs.push(
      window.api.chatOnExpandChunk((data) => {
        const pending = pendingRef.current.get(data.requestId)
        if (!pending || pending.kind !== 'expand') return
        const expansionId = pending.expansionId
        if (expansionId === undefined) return

        const chunk: ExpansionChunk = {
          ...(data.text !== undefined ? { text: data.text } : {}),
          ...(data.done !== undefined ? { done: data.done } : {}),
          ...(data.error !== undefined ? { error: data.error } : {})
        }
        setState((prev) => ({
          ...prev,
          turns: applyExpansionChunk(prev.turns, expansionId, chunk)
        }))

        if (data.error !== undefined || data.done) {
          pendingRef.current.delete(data.requestId)
          requestSave(true)
        }
      })
    )

    if (role === 'lookup') {
      window.api.lookupOnContext((status) => {
        setContextReady(status.status === 'ready')
      })

      window.api.lookupOnGrow(() => {
        options?.onGrown?.()
      })
    }

    unsubs.push(
      window.api.chatOnReplaceConversation((imported) => {
        setState({ ...imported.state, turns: finalizeTurns(imported.state.turns) })
        setLoading(false)
        pendingRef.current.clear()
        activeRequestRef.current = null
        setConversationId(imported.conversationId)
        setConversationTitle(imported.conversationTitle)
        // Keep the meta so the next message updates the transferred record
        // instead of creating a second conversation under a new id.
        conversationMetaRef.current = {
          id: imported.conversationId,
          title: imported.conversationTitle,
          createdAt: imported.conversationCreatedAt,
          updatedAt: new Date().toISOString(),
          kbFed: false
        }
        expansionIdCounterRef.current = maxExpansionId(imported.state.turns) + 1
        options?.onReplaceConversation?.()
      })
    )

    return () => {
      for (const unsub of unsubs) unsub()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const requestCompletion = useCallback(
    (messages: ProviderMessage[], assistantTurnId: number) => {
      const requestId = generateRequestId()
      activeRequestRef.current = requestId
      pendingRef.current.set(requestId, { kind: 'send', turnId: assistantTurnId })
      window.api.chatSend({ messages, requestId, role })
      setLoading(true)
    },
    [role]
  )

  const stop = useCallback(() => {
    const requestId = activeRequestRef.current
    if (!requestId) {
      // Nothing in flight to abort; make sure the UI cannot stay in a loading state.
      setLoading(false)
      return
    }
    window.api.chatCancel(requestId)
  }, [])

  const retry = useCallback(
    (turnId: number) => {
      if (loading) return
      const current = stateRef.current
      const errorIndex = current.turns.findIndex(
        (turn) => turn.id === turnId && turn.role === 'assistant' && turn.error
      )
      if (errorIndex < 0) return
      let hasUserTurn = false
      for (let i = errorIndex - 1; i >= 0; i--) {
        if (current.turns[i].role === 'user') {
          hasUserTurn = true
          break
        }
      }
      if (!hasUserTurn) return

      // Drop the failed answer (and anything after it), keep the user message,
      // and ask again against the same conversation.
      const baseTurns = current.turns.slice(0, errorIndex)
      const baseState: ConversationState = { ...current, turns: baseTurns }
      const assistantTurnId = nextTurnId++
      const messages = serializeForChat(baseState, role as 'chat' | 'lookup')
      setState({
        ...baseState,
        turns: [
          ...baseTurns,
          { id: assistantTurnId, role: 'assistant', content: '', expansions: [] }
        ]
      })
      requestCompletion(messages, assistantTurnId)
    },
    [loading, role, requestCompletion]
  )

  const send = useCallback(
    (content: string) => {
      const trimmed = content.trim()
      if (trimmed === '' || loading) return
      if (role === 'lookup' && !contextReady) return

      if (!conversationMetaRef.current) {
        const id = crypto.randomUUID()
        const title = buildConversationTitle(trimmed)
        const now = new Date().toISOString()
        conversationMetaRef.current = {
          id,
          title,
          createdAt: now,
          updatedAt: now,
          kbFed: false
        }
        setConversationId(id)
        setConversationTitle(title)
      }

      const userTurnId = nextTurnId++
      const assistantTurnId = nextTurnId++
      const userTurn: Turn = {
        id: userTurnId,
        role: 'user',
        content: trimmed,
        expansions: []
      }
      const snapshot = stateRef.current
      const messages = serializeForChat(
        { ...snapshot, turns: [...snapshot.turns, userTurn] },
        role as 'chat' | 'lookup'
      )

      requestCompletion(messages, assistantTurnId)

      setState((prev) => ({
        ...prev,
        turns: [
          ...prev.turns,
          userTurn,
          { id: assistantTurnId, role: 'assistant', content: '', expansions: [] }
        ]
      }))
      if (role === 'lookup' && !hasSentRef.current) {
        window.api.lookupTriggerGrow()
      }
      hasSentRef.current = true
    },
    [loading, role, contextReady, requestCompletion]
  )

  const expand = useCallback(
    (turnId: number, target: ExpansionTarget, prompt?: string): ExpandOutcome => {
      const turn = stateRef.current.turns.find((item) => item.id === turnId)
      if (!turn) return { ok: false, reason: 'Message not found.' }

      const input = expansionMessageInput(turn, target.parentExpansionId, target)
      if (!input) return { ok: false, reason: 'Selection is no longer available.' }
      // Re-check the markdown anchoring against the current source: the range
      // was measured on the DOM, which may lag one streamed chunk behind.
      if (!isAnchoredRange(input.answer, target)) {
        return { ok: false, reason: 'Select text inside a single paragraph.' }
      }

      const expansionId = expansionIdCounterRef.current
      const insertion = insertExpansionInTurns(
        stateRef.current.turns,
        turnId,
        target,
        expansionId,
        prompt
      )
      if (!insertion.ok) return { ok: false, reason: insertion.reason }

      expansionIdCounterRef.current += 1
      const requestId = generateRequestId()

      const expandMessages = buildExpandMessages({
        answer: input.answer,
        selection: input.selection,
        ...(prompt !== undefined ? { prompt } : {})
      })
      const allMessages = [
        {
          role: 'system' as const,
          content: getSystemPrompt(role as 'chat' | 'lookup')
        },
        ...expandMessages
      ]

      pendingRef.current.set(requestId, { kind: 'expand', turnId, expansionId })
      window.api.chatExpand({ messages: allMessages, requestId, role })

      setState((prev) => {
        const result = insertExpansionInTurns(prev.turns, turnId, target, expansionId, prompt)
        return result.ok ? { ...prev, turns: result.turns } : prev
      })
      return { ok: true }
    },
    [role]
  )

  const retryExpansion = useCallback(
    (expansionId: number) => {
      const location = findExpansionInTurns(stateRef.current.turns, expansionId)
      if (!location) return
      const parentId = location.parent?.id
      const input = expansionMessageInput(location.turn, parentId, location.node)
      if (!input || !isAnchoredRange(input.answer, location.node)) return

      const requestId = generateRequestId()
      const messages = [
        {
          role: 'system' as const,
          content: getSystemPrompt(role as 'chat' | 'lookup')
        },
        ...buildExpandMessages({
          answer: input.answer,
          selection: input.selection,
          ...(location.node.prompt !== undefined ? { prompt: location.node.prompt } : {})
        })
      ]

      pendingRef.current.set(requestId, {
        kind: 'expand',
        turnId: location.turn.id,
        expansionId
      })
      setState((prev) => ({
        ...prev,
        turns: updateExpansion(prev.turns, expansionId, {
          answer: '',
          status: 'loading',
          error: undefined
        })
      }))
      window.api.chatExpand({ messages, requestId, role })
      requestSave(true)
    },
    [role, requestSave]
  )

  const dismissExpansion = useCallback(
    (expansionId: number) => {
      setState((prev) => ({
        ...prev,
        turns: removeExpansionInTurns(prev.turns, expansionId)
      }))
      requestSave(true)
    },
    [requestSave]
  )

  const fold = useCallback(
    (expansionId: number) => {
      setState((prev) => ({ ...prev, turns: setExpansionFolded(prev.turns, expansionId, true) }))
      requestSave(false)
    },
    [requestSave]
  )

  const unfold = useCallback(
    (expansionId: number) => {
      setState((prev) => ({ ...prev, turns: setExpansionFolded(prev.turns, expansionId, false) }))
      requestSave(false)
    },
    [requestSave]
  )

  const newChat = useCallback(() => {
    stop()
    saveCurrentState(stateRef.current, false)
    setState({ context: '', turns: [] })
    setLoading(false)
    pendingRef.current.clear()
    activeRequestRef.current = null
    setConversationId(null)
    setConversationTitle('')
    conversationMetaRef.current = null
  }, [saveCurrentState, stop])

  const loadConversation = useCallback(
    async (id: string) => {
      stop()
      pendingRef.current.clear()
      activeRequestRef.current = null
      setLoading(false)

      const meta = conversationMetaRef.current
      if (meta) await saveConversationState(stateRef.current, role, meta)

      const loaded = await window.api.loadConversation(id)
      if (!loaded) return

      setState({ ...loaded.state, turns: finalizeTurns(loaded.state.turns) })
      setConversationId(loaded.id)
      setConversationTitle(loaded.title)
      conversationMetaRef.current = {
        id: loaded.id,
        title: loaded.title,
        createdAt: loaded.createdAt,
        updatedAt: loaded.updatedAt,
        kbFed: loaded.kbFed
      }
      expansionIdCounterRef.current = maxExpansionId(loaded.state.turns) + 1
    },
    [role, stop]
  )

  return {
    state,
    loading,
    contextReady,
    conversationId,
    conversationTitle,
    send,
    stop,
    retry,
    expand,
    retryExpansion,
    dismissExpansion,
    fold,
    unfold,
    newChat,
    loadConversation,
    setState
  }
}
