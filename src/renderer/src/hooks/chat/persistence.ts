/**
 * Conversation autosave: turns the newest committed state into a persisted
 * record. Saves are requested from event handlers and flushed by an effect, so
 * no IPC ever runs inside a `setState` updater (StrictMode double-invokes those).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
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

export type SaveOutcome = { ok: true } | { ok: false; error: string }

export const SAVE_FAILED_MESSAGE = 'This conversation could not be saved'

function saveErrorText(err: unknown): string {
  const detail = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return detail ? `${SAVE_FAILED_MESSAGE}: ${detail}` : `${SAVE_FAILED_MESSAGE}.`
}

/** Persists `state`; `undefined` means there was nothing worth saving. Never rejects. */
export function saveConversationState(
  state: ConversationState,
  role: 'chat' | 'lookup',
  meta: ConversationMeta
): Promise<SaveOutcome> | undefined {
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
  return window.api.saveConversation(record).then(
    (): SaveOutcome => ({ ok: true }),
    (err: unknown): SaveOutcome => {
      console.warn('Failed to save conversation:', err)
      return { ok: false, error: saveErrorText(err) }
    }
  )
}

export function useConversationPersistence(
  state: ConversationState,
  role: 'chat' | 'lookup',
  metaRef: RefObject<ConversationMeta | null>
): {
  requestSave: (touchContent: boolean) => void
  saveSnapshot: (snapshot: ConversationState, touchContent: boolean) => void
  /** The newest autosave failure for the open conversation; cleared by the next success. */
  saveError: string | null
  reportSaveOutcome: (id: string, outcome: SaveOutcome | undefined) => void
  clearSaveError: () => void
} {
  const saveRequestRef = useRef<SaveRequest>({ pending: false, touchContent: false })
  const [saveError, setSaveError] = useState<string | null>(null)

  const clearSaveError = useCallback((): void => setSaveError(null), [])

  const reportSaveOutcome = useCallback(
    (id: string, outcome: SaveOutcome | undefined): void => {
      // A save that settles after the user moved to another chat says nothing about this one.
      if (!outcome || metaRef.current?.id !== id) return
      setSaveError(outcome.ok ? null : outcome.error)
    },
    [metaRef]
  )

  const saveSnapshot = useCallback(
    (snapshot: ConversationState, touchContent: boolean): void => {
      const meta = metaRef.current
      if (!meta) return
      if (touchContent) meta.updatedAt = new Date().toISOString()
      void saveConversationState(snapshot, role, meta)?.then((outcome) =>
        reportSaveOutcome(meta.id, outcome)
      )
    },
    [role, metaRef, reportSaveOutcome]
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

  return { requestSave, saveSnapshot, saveError, reportSaveOutcome, clearSaveError }
}
