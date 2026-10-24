/**
 * Conversation autosave: turns the newest committed state into a persisted
 * record. Saves are requested from event handlers and flushed by an effect, so
 * no IPC ever runs inside a `setState` updater (StrictMode double-invokes those).
 */
import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { ConversationRecord, ConversationState } from '../../../../shared/conversation'
import { persistableTurns } from '../../../../shared/conversation'
import { finalizeTurns } from '../../../../shared/rich-text'

export interface ConversationMeta {
  id: string
  title: string
  createdAt: string
  /** Last *content* change; fold/dismiss/rename never move this. */
  updatedAt: string
  kbFed: boolean
}

interface SaveRequest {
  pending: boolean
  touchContent: boolean
}

export function saveConversationState(
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

export function useConversationPersistence(
  state: ConversationState,
  role: 'chat' | 'lookup',
  metaRef: RefObject<ConversationMeta | null>
): {
  requestSave: (touchContent: boolean) => void
  saveSnapshot: (snapshot: ConversationState, touchContent: boolean) => void
} {
  const saveRequestRef = useRef<SaveRequest>({ pending: false, touchContent: false })

  const saveSnapshot = useCallback(
    (snapshot: ConversationState, touchContent: boolean): void => {
      const meta = metaRef.current
      if (!meta) return
      if (touchContent) meta.updatedAt = new Date().toISOString()
      void saveConversationState(snapshot, role, meta)
    },
    [role, metaRef]
  )

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
    saveSnapshot(state, touchContent)
  }, [state, saveSnapshot])

  return { requestSave, saveSnapshot }
}
