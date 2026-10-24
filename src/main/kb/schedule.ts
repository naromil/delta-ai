/**
 * Timing and selection policy for automatic Knowledge Base maintenance.
 *
 * Pure functions only: the scheduler in `maintenance.ts` owns timers, disk and
 * IPC, so the decisions that matter (when to run, what to run on, how long to
 * back off) can be tested without Electron.
 */

/** Quiet period after the last conversation write before learning starts. */
export const AUTO_DEBOUNCE_MS = 20_000
/** Earliest an automatic pass may follow the previous one across a restart. */
export const AUTO_MIN_INTERVAL_MS = 10 * 60_000
/** Gap between passes while a backlog remains, so history drains in bounded batches. */
export const AUTO_BACKLOG_INTERVAL_MS = 45_000
/** Conversations folded into the profile per pass; keeps one run's cost bounded. */
export const AUTO_BATCH_SIZE = 4
export const AUTO_RETRY_BASE_MS = 2 * 60_000
export const AUTO_RETRY_MAX_MS = 30 * 60_000
/** Minimum delay after launch, so window creation and the first paint win the CPU. */
export const AUTO_STARTUP_DELAY_MS = 15_000

/** Exponential retry with a ceiling: a broken provider must never be hammered. */
export function autoRetryDelayMs(failedAttempts: number): number {
  const attempts = Math.max(1, Math.trunc(failedAttempts))
  return Math.min(AUTO_RETRY_MAX_MS, AUTO_RETRY_BASE_MS * 2 ** (attempts - 1))
}

/**
 * Delay after a finished pass: retry with backoff on failure, keep draining a
 * backlog shortly after a success, otherwise stay idle until the next write.
 */
export function autoFollowUpDelayMs(input: {
  pending: boolean
  failed: boolean
  failedAttempts: number
}): number {
  if (input.failed) return autoRetryDelayMs(input.failedAttempts)
  return input.pending ? AUTO_BACKLOG_INTERVAL_MS : 0
}

/**
 * The next batch of learning material. Only chat conversations that have not
 * been folded in yet: standalone look-ups are screen-context noise, and an
 * already-fed conversation must not be re-folded by a later save.
 */
export function selectAutoBatch<T extends { source: 'chat' | 'lookup'; kbFed: boolean }>(
  metas: T[],
  limit: number = AUTO_BATCH_SIZE
): T[] {
  const size = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : AUTO_BATCH_SIZE
  return metas.filter((meta) => meta.source === 'chat' && !meta.kbFed).slice(0, size)
}

/** Startup pacing: honour the steady-state interval, never launch sooner than the floor. */
export function startupDelayMs(lastRunAt: string | null, now: number): number {
  const last = lastRunAt ? Date.parse(lastRunAt) : NaN
  const elapsed = Number.isFinite(last) ? now - last : AUTO_MIN_INTERVAL_MS
  const remaining = Math.min(AUTO_MIN_INTERVAL_MS, AUTO_MIN_INTERVAL_MS - elapsed)
  return Math.max(AUTO_STARTUP_DELAY_MS, remaining)
}
