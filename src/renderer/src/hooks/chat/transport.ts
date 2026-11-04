/**
 * Streaming IPC subscriptions for the chat hook.
 *
 * Every listener first resolves its `requestId` in the request book; a settled
 * or cancelled request is not in the book, so its late chunks and responses are
 * dropped instead of being applied to a turn that may already be gone.
 */
import type { Dispatch, SetStateAction } from 'react'
import type { ConversationState } from '../../../../shared/conversation'
import type { ExpansionChunk } from '../../../../shared/rich-text'
import { applyExpansionChunk } from '../../../../shared/rich-text'
import { pendingRequest, settleRequest } from './requests'
import type { RequestBookkeeping } from './requests'

export interface ReplaceConversationPayload {
  state: ConversationState
  conversationId: string
  conversationTitle: string
  conversationCreatedAt: string
}

export interface ChatTransportHandlers {
  role: 'chat' | 'lookup'
  getRequests: () => RequestBookkeeping
  setRequests: (book: RequestBookkeeping) => void
  setState: Dispatch<SetStateAction<ConversationState>>
  setLoading: (loading: boolean) => void
  setContextReady: (contextReady: boolean) => void
  requestSave: (touchContent: boolean) => void
  onReplaceConversation?: (payload: ReplaceConversationPayload) => void
  onGrown?: () => void
}

export function subscribeChatTransport(handlers: ChatTransportHandlers): () => void {
  const unsubs: Array<() => void> = []

  unsubs.push(
    window.api.chatOnChunk((data) => {
      const pending = pendingRequest(handlers.getRequests(), data.requestId, 'send')
      if (!pending) return

      handlers.setState((prev) => {
        const turns = [...prev.turns]
        const turnIdx = turns.findIndex((t) => t.id === pending.turnId)
        if (turnIdx < 0) return prev
        turns[turnIdx] = { ...turns[turnIdx], content: turns[turnIdx].content + data.delta }
        return { ...prev, turns }
      })
    })
  )

  unsubs.push(
    window.api.chatOnResponse((data) => {
      const requests = handlers.getRequests()
      const pending = pendingRequest(requests, data.requestId, 'send')
      if (!pending) return

      handlers.setRequests(settleRequest(requests, data.requestId).book)
      handlers.setState((prev) => {
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
      handlers.setLoading(false)
      handlers.requestSave(true)
    })
  )

  unsubs.push(
    window.api.chatOnError((data) => {
      const requests = handlers.getRequests()
      const pending = pendingRequest(requests, data.requestId, 'send')
      if (!pending) return

      handlers.setRequests(settleRequest(requests, data.requestId).book)
      handlers.setState((prev) => {
        const turns = [...prev.turns]
        const turnIdx = turns.findIndex((t) => t.id === pending.turnId)
        if (turnIdx < 0) return prev
        turns[turnIdx] = { ...turns[turnIdx], content: data.error, error: true }
        return { ...prev, turns }
      })
      handlers.setLoading(false)
      // Keep the failure on disk so Retry survives a reload.
      handlers.requestSave(true)
    })
  )

  unsubs.push(
    window.api.chatOnExpandChunk((data) => {
      const requests = handlers.getRequests()
      const pending = pendingRequest(requests, data.requestId, 'expand')
      const expansionId = pending?.expansionId
      if (expansionId === undefined) return

      const chunk: ExpansionChunk = {
        ...(data.delta !== undefined ? { delta: data.delta } : {}),
        ...(data.text !== undefined ? { text: data.text } : {}),
        ...(data.done !== undefined ? { done: data.done } : {}),
        ...(data.error !== undefined ? { error: data.error } : {})
      }
      handlers.setState((prev) => ({
        ...prev,
        turns: applyExpansionChunk(prev.turns, expansionId, chunk)
      }))

      if (data.error !== undefined || data.done) {
        handlers.setRequests(settleRequest(requests, data.requestId).book)
        handlers.requestSave(true)
      }
    })
  )

  if (handlers.role === 'lookup') {
    window.api.lookupOnContext((status) => {
      handlers.setContextReady(status.status === 'ready')
    })

    window.api.lookupOnGrow(() => {
      handlers.onGrown?.()
    })
  }

  unsubs.push(
    window.api.chatOnReplaceConversation((imported) => {
      handlers.onReplaceConversation?.(imported)
    })
  )

  return () => {
    for (const unsub of unsubs) unsub()
  }
}
