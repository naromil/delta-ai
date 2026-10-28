import { useState, useRef, useCallback, useEffect } from 'react'
import type { ConversationState, Turn, ProviderMessage } from '../../../shared/conversation'
import {
  serializeForChat,
  buildConversationTitle,
  CONVERSATION_TITLE_MAX_LENGTH
} from '../../../shared/conversation'
import type { ExpansionTarget } from '../../../shared/rich-text'
import {
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
import {
  clearRequests,
  createRequests,
  discardExpands,
  discardExpandsForTurns,
  generateRequestId,
  registerExpand,
  registerSend
} from './chat/requests'
import type { RequestBookkeeping } from './chat/requests'
import { saveConversationState, useConversationPersistence } from './chat/persistence'
import type { ConversationMeta } from './chat/persistence'
import { subscribeChatTransport } from './chat/transport'

let nextTurnId = Date.now()

/** Why an expand request was refused; the UI surfaces this instead of silence. */
export type ExpandOutcome = { ok: true } | { ok: false; reason: string }

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
  regenerate: (turnId: number) => void
  editMessage: (turnId: number, content: string) => void
  expand: (turnId: number, target: ExpansionTarget, prompt?: string) => ExpandOutcome
  retryExpansion: (expansionId: number) => void
  dismissExpansion: (expansionId: number) => void
  fold: (id: number) => void
  unfold: (id: number) => void
  renameConversation: (title: string) => void
  newChat: () => void
  deleteConversation: () => Promise<void>
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
  const requestsRef = useRef<RequestBookkeeping>(createRequests())
  const expansionIdCounterRef = useRef(1)
  const hasSentRef = useRef(false)
  const conversationMetaRef = useRef<ConversationMeta | null>(null)
  const stateRef = useRef<ConversationState>({
    context: options?.initial?.context ?? '',
    systemNote: options?.initial?.systemNote ?? '',
    turns: options?.initial?.turns ?? []
  })

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const { requestSave, saveSnapshot } = useConversationPersistence(state, role, conversationMetaRef)

  const getRequests = useCallback((): RequestBookkeeping => requestsRef.current, [])

  const setRequests = useCallback((book: RequestBookkeeping): void => {
    requestsRef.current = book
  }, [])

  const cancelAllRequests = useCallback((): void => {
    const { book, requestIds } = clearRequests(requestsRef.current)
    requestsRef.current = book
    for (const requestId of requestIds) window.api.chatCancel(requestId)
  }, [])

  useEffect(() => {
    return subscribeChatTransport({
      role,
      getRequests,
      setRequests,
      setState,
      setLoading,
      setContextReady,
      requestSave,
      onGrown: options?.onGrown,
      onReplaceConversation: (imported) => {
        // The transferred conversation replaces every in-flight request; their
        // late chunks must not land on turns of the imported state.
        cancelAllRequests()
        setState({ ...imported.state, turns: finalizeTurns(imported.state.turns) })
        setLoading(false)
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
      }
    })
    // Subscriptions are mounted once: the IPC bridge outlives every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const requestCompletion = useCallback(
    (messages: ProviderMessage[], assistantTurnId: number) => {
      const requestId = generateRequestId()
      requestsRef.current = registerSend(requestsRef.current, requestId, assistantTurnId)
      window.api.chatSend({ messages, requestId, role })
      setLoading(true)
    },
    [role]
  )

  const stop = useCallback(() => {
    // Expands are cancellable too: drop them *before* cancelling so their
    // pending chunks cannot land on a frame that just became an error.
    const expands = discardExpands(requestsRef.current)
    requestsRef.current = expands.book
    for (const requestId of expands.requestIds) window.api.chatCancel(requestId)
    if (expands.requestIds.length > 0) {
      setState((prev) => ({ ...prev, turns: finalizeTurns(prev.turns) }))
    }

    const activeSendId = expands.book.activeSendId
    if (!activeSendId) {
      // Nothing in flight to abort; make sure the UI cannot stay in a loading state.
      setLoading(false)
      return
    }
    window.api.chatCancel(activeSendId)
  }, [])

  /**
   * Drops the turn at `cutIndex` and everything after it, optionally appends a
   * replacement user turn, and re-sends the conversation for a fresh answer.
   */
  const truncateAndResend = useCallback(
    (cutIndex: number, userTurn?: Turn) => {
      const current = stateRef.current
      // Anything after the cut is being replaced; expand streams attached to
      // those turns must not keep running against state that no longer exists.
      const droppedTurnIds = new Set(current.turns.slice(cutIndex).map((turn) => turn.id))
      const expands = discardExpandsForTurns(requestsRef.current, droppedTurnIds)
      requestsRef.current = expands.book
      for (const requestId of expands.requestIds) window.api.chatCancel(requestId)

      const baseTurns = [...current.turns.slice(0, cutIndex), ...(userTurn ? [userTurn] : [])]
      const baseState: ConversationState = { ...current, turns: baseTurns }
      const assistantTurnId = nextTurnId++
      const messages = serializeForChat(baseState, role)
      setState({
        ...baseState,
        turns: [
          ...baseTurns,
          { id: assistantTurnId, role: 'assistant', content: '', expansions: [] }
        ]
      })
      requestCompletion(messages, assistantTurnId)
    },
    [role, requestCompletion]
  )

  const replaceAssistantTurn = useCallback(
    (turnId: number, errorOnly: boolean) => {
      if (loading) return
      const current = stateRef.current
      const turnIndex = current.turns.findIndex((turn) => turn.id === turnId)
      const target = turnIndex >= 0 ? current.turns[turnIndex] : undefined
      if (!target || target.role !== 'assistant') return
      if (errorOnly ? !target.error : target.content.trim() === '') return

      let hasUserTurn = false
      for (let i = turnIndex - 1; i >= 0; i--) {
        if (current.turns[i].role === 'user') {
          hasUserTurn = true
          break
        }
      }
      if (!hasUserTurn) return

      truncateAndResend(turnIndex)
    },
    [loading, truncateAndResend]
  )

  const retry = useCallback(
    (turnId: number) => {
      replaceAssistantTurn(turnId, true)
    },
    [replaceAssistantTurn]
  )

  const regenerate = useCallback(
    (turnId: number) => {
      replaceAssistantTurn(turnId, false)
    },
    [replaceAssistantTurn]
  )

  const editMessage = useCallback(
    (turnId: number, content: string) => {
      const trimmed = content.trim()
      if (trimmed === '' || loading) return
      const turnIndex = stateRef.current.turns.findIndex((turn) => turn.id === turnId)
      if (turnIndex < 0 || stateRef.current.turns[turnIndex].role !== 'user') return
      truncateAndResend(turnIndex, {
        id: nextTurnId++,
        role: 'user',
        content: trimmed,
        expansions: []
      })
    },
    [loading, truncateAndResend]
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

  const startExpansion = useCallback(
    (turnId: number, expansionId: number, messages: ProviderMessage[]): void => {
      const requestId = generateRequestId()
      requestsRef.current = registerExpand(requestsRef.current, requestId, turnId, expansionId)
      window.api.chatExpand({ messages, requestId, role })
    },
    [role]
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
      const allMessages: ProviderMessage[] = [
        {
          role: 'system',
          content: getSystemPrompt(role as 'chat' | 'lookup')
        },
        ...buildExpandMessages({
          answer: input.answer,
          selection: input.selection,
          ...(prompt !== undefined ? { prompt } : {})
        })
      ]

      startExpansion(turnId, expansionId, allMessages)

      setState((prev) => {
        const result = insertExpansionInTurns(prev.turns, turnId, target, expansionId, prompt)
        return result.ok ? { ...prev, turns: result.turns } : prev
      })
      return { ok: true }
    },
    [role, startExpansion]
  )

  const retryExpansion = useCallback(
    (expansionId: number) => {
      const location = findExpansionInTurns(stateRef.current.turns, expansionId)
      if (!location) return
      const parentId = location.parent?.id
      const input = expansionMessageInput(location.turn, parentId, location.node)
      if (!input || !isAnchoredRange(input.answer, location.node)) return

      const messages: ProviderMessage[] = [
        {
          role: 'system',
          content: getSystemPrompt(role as 'chat' | 'lookup')
        },
        ...buildExpandMessages({
          answer: input.answer,
          selection: input.selection,
          ...(location.node.prompt !== undefined ? { prompt: location.node.prompt } : {})
        })
      ]

      startExpansion(location.turn.id, expansionId, messages)
      setState((prev) => ({
        ...prev,
        turns: updateExpansion(prev.turns, expansionId, {
          answer: '',
          status: 'loading',
          error: undefined
        })
      }))
      requestSave(true)
    },
    [role, startExpansion, requestSave]
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

  const renameConversation = useCallback(
    (title: string) => {
      const meta = conversationMetaRef.current
      if (!meta) return
      const trimmed = title.trim().slice(0, CONVERSATION_TITLE_MAX_LENGTH).trimEnd()
      if (trimmed === '' || trimmed === meta.title) return
      meta.title = trimmed
      setConversationTitle(trimmed)
      // A rename is metadata, not content: recents keep their order.
      requestSave(false)
    },
    [requestSave]
  )

  const newChat = useCallback(() => {
    cancelAllRequests()
    saveSnapshot(stateRef.current, false)
    setState({ context: '', turns: [] })
    setLoading(false)
    setConversationId(null)
    setConversationTitle('')
    conversationMetaRef.current = null
  }, [cancelAllRequests, saveSnapshot])

  const deleteConversation = useCallback(async (): Promise<void> => {
    const meta = conversationMetaRef.current
    if (!meta) return
    cancelAllRequests()
    // Detach before the delete so no later autosave can recreate the record.
    conversationMetaRef.current = null
    setState({ context: '', turns: [] })
    setLoading(false)
    setConversationId(null)
    setConversationTitle('')
    await window.api.deleteConversation(meta.id)
  }, [cancelAllRequests])

  const loadConversation = useCallback(
    async (id: string) => {
      cancelAllRequests()
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
    [cancelAllRequests, role]
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
    regenerate,
    editMessage,
    expand,
    retryExpansion,
    dismissExpansion,
    fold,
    unfold,
    renameConversation,
    newChat,
    deleteConversation,
    loadConversation,
    setState
  }
}
