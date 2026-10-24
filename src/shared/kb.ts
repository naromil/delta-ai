import type { CategorizedKeyword } from './models'

/* ---- Knowledge base maintenance ---- */

/** What the automatic learning loop is doing right now. */
export type KbMaintenanceState = 'idle' | 'running' | 'error'

/** Snapshot the Knowledge Base view renders; pushed on every change. */
export interface KbMaintenanceStatus {
  /** User preference (`settings.json` → `kbAutoMaintain`). */
  enabled: boolean
  /** True only when the `kb-maintenance` role resolves to a connection + model. */
  configured: boolean
  state: KbMaintenanceState
  /** Chat conversations waiting to be learned from. */
  pending: number
  /** ISO timestamp of the last successful profile update, automatic or manual. */
  lastLearnedAt: string | null
  /** Conversations folded into the profile by the last successful run. */
  lastAnalyzed: number
  lastError: string | null
}

export interface KbRunResult {
  newPrompt: string
  keywords: CategorizedKeyword[]
  conversationsAnalyzed: number
}

/**
 * `{userData}/kb/state.json`. Survives restarts so the loop can pace itself
 * (startup respects the interval since the last run) and so the UI can report
 * the last failure instead of retrying blindly.
 */
export interface KbPersistedState {
  lastRunAt: string | null
  lastLearnedAt: string | null
  lastAnalyzed: number
  lastError: string | null
  failedAttempts: number
}

export function emptyKbState(): KbPersistedState {
  return {
    lastRunAt: null,
    lastLearnedAt: null,
    lastAnalyzed: 0,
    lastError: null,
    failedAttempts: 0
  }
}

/** Accept only the shapes the loop can honour; a hand-edited file must not poison it. */
export function normalizeKbState(raw: unknown): KbPersistedState {
  const record =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : ({} as const)
  const isoOrNull = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value : null
  const count = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
  return {
    lastRunAt: isoOrNull(record.lastRunAt),
    lastLearnedAt: isoOrNull(record.lastLearnedAt),
    lastAnalyzed: count(record.lastAnalyzed),
    lastError: isoOrNull(record.lastError),
    failedAttempts: count(record.failedAttempts)
  }
}
