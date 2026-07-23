import { useState, useRef, useCallback, useEffect } from 'react'
import type {
  ConversationState,
  Turn,
  ExpandableSegment,
  ConversationRecord
} from '../../../shared/conversation'
import {
  tokenize,
  flattenMarkdown,
  insertExpansionNested,
  updateExpansionInTurns,
  toggleExpansionFoldedInTurns,
  serializeForChat
} from '../../../shared/conversation'
import { getSystemPrompt } from '../../../shared/prompts'
import { buildExpandMessages } from '../../../shared/expand-prompt'

function generateId(): number {
  return Date.now() + Math.floor(Math.random() * 10000)
}

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
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
    prompt?: string
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
          const newState = { ...prev, turns }
          const meta = conversationMetaRef.current
          if (meta) {
            const record: ConversationRecord = {
              id: meta.id,
              title: meta.title,
              createdAt: meta.createdAt,
              updatedAt: new Date().toISOString(),
              source: role === 'lookup' ? 'lookup' : 'chat',
              state: newState,
              kbFed: false
            }
            window.api.saveConversation(record)
          }
          return newState
        })
        pendingRef.current.delete(data.requestId)
        setLoading(false)
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
        let maxId = 0
        function scanSegments(segments: ExpandableSegment[] | undefined): void {
          if (!segments) return
          for (const seg of segments) {
            if ('expansionId' in seg && typeof seg.expansionId === 'number') {
              if (seg.expansionId > maxId) maxId = seg.expansionId
            }
            if ('segments' in seg && Array.isArray(seg.segments)) {
              scanSegments(seg.segments)
            }
          }
        }
        scanSegments(imported.state.turns.flatMap((t) => t.segments ?? []))
        expansionIdCounterRef.current = maxId + 1
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
        const flat = flattenMarkdown(trimmed).replace(/\s+/g, ' ').trim()
        const title = flat.length <= 60 ? flat : flat.slice(0, 60).trimEnd()
        const createdAt = new Date().toISOString()
        conversationMetaRef.current = { id, title, createdAt }
        setConversationId(id)
        setConversationTitle(title)
      }

      const turnId = generateId()
      const requestId = generateRequestId()

      setState((prev) => {
        const newTurn: Turn = {
          id: turnId - 1,
          role: 'user',
          content: trimmed,
          segments: tokenize(trimmed)
        }
        const messages = serializeForChat(
          { ...prev, turns: [...prev.turns, newTurn] },
          role as 'chat' | 'lookup'
        )
        window.api.chatSend({ messages, requestId, role })
        pendingRef.current.set(requestId, { kind: 'send', turnId })

        return {
          ...prev,
          turns: [...prev.turns, newTurn, { id: turnId, role: 'assistant', content: '' }]
        }
      })
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
      prompt?: string
    ) => {
      const expansionId = expansionIdCounterRef.current++
      const requestId = generateRequestId()

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
          expansionId
        )

        turns[turnIdx] = { ...turn, segments: newSegments }

        pendingRef.current.set(requestId, { kind: 'expand', turnId, expansionId })

        const expandMessages = buildExpandMessages({ answer: parentAnswer, selection, prompt })
        const allMessages = [
          {
            role: 'system' as const,
            content: getSystemPrompt(role as 'chat' | 'lookup')
          },
          ...expandMessages
        ]
        window.api.chatExpand({ messages: allMessages, requestId, role })

        return { ...prev, turns }
      })
    },
    [role]
  )

  const fold = useCallback((expansionId: number) => {
    setState((prev) => ({
      ...prev,
      turns: toggleExpansionFoldedInTurns(prev.turns, expansionId, true)
    }))
  }, [])

  const unfold = useCallback((expansionId: number) => {
    setState((prev) => ({
      ...prev,
      turns: toggleExpansionFoldedInTurns(prev.turns, expansionId, false)
    }))
  }, [])

  const newChat = useCallback(() => {
    const meta = conversationMetaRef.current
    const currentState = stateRef.current
    if (meta && currentState.turns.length > 0) {
      const record: ConversationRecord = {
        id: meta.id,
        title: meta.title,
        createdAt: meta.createdAt,
        updatedAt: new Date().toISOString(),
        source: role === 'lookup' ? 'lookup' : 'chat',
        state: currentState,
        kbFed: false
      }
      window.api.saveConversation(record)
    }
    setState({ context: '', turns: [] })
    setLoading(false)
    pendingRef.current.clear()
    setConversationId(null)
    setConversationTitle('')
    conversationMetaRef.current = null
  }, [role])

  const loadConversation = useCallback(
    async (id: string) => {
      const meta = conversationMetaRef.current
      const currentState = stateRef.current
      if (meta && currentState.turns.length > 0) {
        const record: ConversationRecord = {
          id: meta.id,
          title: meta.title,
          createdAt: meta.createdAt,
          updatedAt: new Date().toISOString(),
          source: role === 'lookup' ? 'lookup' : 'chat',
          state: currentState,
          kbFed: false
        }
        await window.api.saveConversation(record)
      }

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

      let maxId = 0
      function scanSegments(segments: ExpandableSegment[] | undefined): void {
        if (!segments) return
        for (const seg of segments) {
          if ('expansionId' in seg && typeof seg.expansionId === 'number') {
            if (seg.expansionId > maxId) maxId = seg.expansionId
          }
          if ('segments' in seg && Array.isArray(seg.segments)) {
            scanSegments(seg.segments)
          }
        }
      }
      scanSegments(loaded.state.turns.flatMap((t) => t.segments ?? []))
      expansionIdCounterRef.current = maxId + 1
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
