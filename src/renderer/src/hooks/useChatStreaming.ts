import { useState, useRef, useCallback, useEffect } from 'react'
import type { ConversationState, Turn, ConversationRecord } from '../../../shared/conversation'
import {
  tokenize,
  insertExpansionNested,
  updateExpansionInTurns,
  toggleExpansionFoldedInTurns,
  serializeForChat,
  buildConversationTitle,
  maxExpansionId
} from '../../../shared/conversation'
import { getSystemPrompt } from '../../../shared/prompts'
import { buildExpandMessages } from '../../../shared/expand-prompt'

let nextTurnId = Date.now()

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function saveConversationState(
  state: ConversationState,
  role: 'chat' | 'lookup',
  meta: { id: string; title: string; createdAt: string }
): Promise<void> | undefined {
  if (state.turns.length === 0 || state.turns.every((t) => t.content.trim() === '')) {
    return undefined
  }
  const record: ConversationRecord = {
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: new Date().toISOString(),
    source: role === 'lookup' ? 'lookup' : 'chat',
    state,
    kbFed: false
  }
  return window.api.saveConversation(record)
}

interface PendingRequest {
  kind: 'send' | 'expand'
  turnId: number
  expansionId?: number
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
  expand: (
    turnId: number,
    selection: string,
    startIndex: number,
    endIndex: number,
    isNested: boolean,
    parentAnswer: string,
    parentExpansionId?: number,
    prompt?: string,
    startOffset?: number,
    endOffset?: number
  ) => void
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
  const expansionIdCounterRef = useRef(1)
  const hasSentRef = useRef(false)
  const conversationMetaRef = useRef<{ id: string; title: string; createdAt: string } | null>(null)
  const stateRef = useRef<ConversationState>({
    context: options?.initial?.context ?? '',
    systemNote: options?.initial?.systemNote ?? '',
    turns: options?.initial?.turns ?? []
  })

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const saveCurrentState = useCallback(
    (s: ConversationState): void => {
      const meta = conversationMetaRef.current
      if (!meta) return
      void saveConversationState(s, role, meta)
    },
    [role]
  )

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
          turns[turnIdx] = {
            ...turns[turnIdx],
            content: data.text,
            segments: tokenize(data.text)
          }
          return { ...prev, turns }
        })
        pendingRef.current.delete(data.requestId)
        setLoading(false)
        setTimeout(() => saveCurrentState(stateRef.current), 0)
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
        setLoading(false)
      })
    )

    unsubs.push(
      window.api.chatOnExpandChunk((data) => {
        const pending = pendingRef.current.get(data.requestId)
        if (!pending || pending.kind !== 'expand') return
        const expId = pending.expansionId
        if (expId === undefined) return

        if (data.error) {
          setState((prev) => ({
            ...prev,
            turns: updateExpansionInTurns(prev.turns, expId, {
              loading: false,
              error: data.error,
              cachedText: data.error ?? 'An error occurred'
            })
          }))
          pendingRef.current.delete(data.requestId)
          setTimeout(() => saveCurrentState(stateRef.current), 0)
          return
        }

        const text = data.text
        if (text) {
          setState((prev) => ({
            ...prev,
            turns: updateExpansionInTurns(prev.turns, expId, {
              loading: false,
              cachedText: text,
              segments: tokenize(text)
            })
          }))
        }

        if (data.done) {
          pendingRef.current.delete(data.requestId)
          setTimeout(() => saveCurrentState(stateRef.current), 0)
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
        setState(imported.state)
        setLoading(false)
        pendingRef.current.clear()
        setConversationId(imported.conversationId)
        setConversationTitle(imported.conversationTitle)
        conversationMetaRef.current = null
        expansionIdCounterRef.current = maxExpansionId(imported.state.turns) + 1
        options?.onReplaceConversation?.()
      })
    )

    return () => {
      for (const unsub of unsubs) unsub()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const send = useCallback(
    (content: string) => {
      const trimmed = content.trim()
      if (trimmed === '' || loading) return
      if (role === 'lookup' && !contextReady) return

      if (!conversationMetaRef.current) {
        const id = crypto.randomUUID()
        const title = buildConversationTitle(trimmed)
        const createdAt = new Date().toISOString()
        conversationMetaRef.current = { id, title, createdAt }
        setConversationId(id)
        setConversationTitle(title)
      }

      const userTurnId = nextTurnId++
      const assistantTurnId = nextTurnId++
      const requestId = generateRequestId()

      const userTurn: Turn = {
        id: userTurnId,
        role: 'user',
        content: trimmed,
        segments: tokenize(trimmed)
      }
      const snapshot = stateRef.current
      const messages = serializeForChat(
        { ...snapshot, turns: [...snapshot.turns, userTurn] },
        role as 'chat' | 'lookup'
      )

      pendingRef.current.set(requestId, { kind: 'send', turnId: assistantTurnId })
      window.api.chatSend({ messages, requestId, role })

      setState((prev) => ({
        ...prev,
        turns: [...prev.turns, userTurn, { id: assistantTurnId, role: 'assistant', content: '' }]
      }))
      if (role === 'lookup' && !hasSentRef.current) {
        window.api.lookupTriggerGrow()
      }
      hasSentRef.current = true

      setLoading(true)
    },
    [loading, role, contextReady]
  )

  const expand = useCallback(
    (
      turnId: number,
      selection: string,
      startIndex: number,
      endIndex: number,
      _isNested: boolean,
      parentAnswer: string,
      parentExpansionId?: number,
      prompt?: string,
      startOffset?: number,
      endOffset?: number
    ) => {
      const expansionId = expansionIdCounterRef.current++
      const requestId = generateRequestId()

      const targetTurn = stateRef.current.turns.find((t) => t.id === turnId)
      if (!targetTurn || !targetTurn.segments) return

      const expandMessages = buildExpandMessages({ answer: parentAnswer, selection, prompt })
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
        const turns = [...prev.turns]
        const turnIdx = turns.findIndex((t) => t.id === turnId)
        if (turnIdx < 0) return prev

        const turn = turns[turnIdx]
        if (!turn.segments) return prev

        const newSegments = insertExpansionNested(
          turn.segments,
          parentExpansionId,
          startIndex,
          endIndex,
          selection,
          expansionId,
          startOffset,
          endOffset,
          prompt
        )

        turns[turnIdx] = { ...turn, segments: newSegments }
        return { ...prev, turns }
      })
    },
    [role]
  )

  const fold = useCallback(
    (expansionId: number) => {
      setState((prev) => {
        const newState = {
          ...prev,
          turns: toggleExpansionFoldedInTurns(prev.turns, expansionId, true)
        }
        setTimeout(() => saveCurrentState(newState), 0)
        return newState
      })
    },
    [saveCurrentState]
  )

  const unfold = useCallback(
    (expansionId: number) => {
      setState((prev) => {
        const newState = {
          ...prev,
          turns: toggleExpansionFoldedInTurns(prev.turns, expansionId, false)
        }
        setTimeout(() => saveCurrentState(newState), 0)
        return newState
      })
    },
    [saveCurrentState]
  )

  const newChat = useCallback(() => {
    const currentState = stateRef.current
    saveCurrentState(currentState)
    setState({ context: '', turns: [] })
    setLoading(false)
    pendingRef.current.clear()
    setConversationId(null)
    setConversationTitle('')
    conversationMetaRef.current = null
  }, [saveCurrentState])

  const loadConversation = useCallback(
    async (id: string) => {
      const currentState = stateRef.current
      const meta = conversationMetaRef.current
      if (meta) await saveConversationState(currentState, role, meta)

      const loaded = await window.api.loadConversation(id)
      if (!loaded) return

      setState(loaded.state)
      setConversationId(loaded.id)
      setConversationTitle(loaded.title)
      conversationMetaRef.current = {
        id: loaded.id,
        title: loaded.title,
        createdAt: loaded.createdAt
      }
      pendingRef.current.clear()
      setLoading(false)

      expansionIdCounterRef.current = maxExpansionId(loaded.state.turns) + 1
    },
    [role]
  )

  return {
    state,
    loading,
    contextReady,
    conversationId,
    conversationTitle,
    send,
    expand,
    fold,
    unfold,
    newChat,
    loadConversation,
    setState
  }
}
