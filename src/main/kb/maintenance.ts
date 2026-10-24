import { BrowserWindow } from 'electron'
import type { ConversationMeta, ConversationRecord } from '../../shared/conversation'
import type { KbMaintenanceStatus, KbRunResult } from '../../shared/kb'
import { loadAppSettings, onAppConfigChanged, resolveRole } from '../config'
import { listUnfedConversations, onConversationSaved, resetKbFedFlags } from '../conversations'
import { runKbAnalysis } from './run'
import {
  AUTO_BACKLOG_INTERVAL_MS,
  AUTO_DEBOUNCE_MS,
  autoFollowUpDelayMs,
  selectAutoBatch,
  startupDelayMs
} from './schedule'
import { loadKbState, resetKb, saveKbState } from './store'

/**
 * Automatic Knowledge Base maintenance.
 *
 * The profile learns itself: every saved chat conversation is a signal, a quiet
 * period after the last write starts a bounded pass, and the learned prompt is
 * rewritten in the background. Look-ups read `prompt.txt` per request, so a
 * finished pass takes effect immediately without any user action.
 *
 * Pacing rules:
 * - runs are serialized through one queue, shared with the manual Analyze buttons;
 * - a pass processes at most `AUTO_BATCH_SIZE` conversations, then the backlog
 *   continues on a short timer, so first-run history never becomes one huge call;
 * - failures back off exponentially and land in `state.json` for the UI;
 * - nothing runs without a `kb-maintenance` model assignment.
 */

let timer: NodeJS.Timeout | null = null
let running = false
let started = false
let pendingCount = 0
let queue: Promise<unknown> = Promise.resolve()
let unsubscribeConversations: (() => void) | null = null
let unsubscribeConfig: (() => void) | null = null
let activeRunController: AbortController | null = null

/* ---- Queue ---- */

/** Serializes every KB pass, manual or automatic, so two runs never interleave writes. */
function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task)
  queue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

/* ---- Status ---- */

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function countPending(): Promise<number> {
  const unfed = await listUnfedConversations()
  return selectAutoBatch(unfed, Number.MAX_SAFE_INTEGER).length
}

function buildStatus(): KbMaintenanceStatus {
  const state = loadKbState()
  return {
    enabled: loadAppSettings().kbAutoMaintain,
    configured: resolveRole('kb-maintenance') !== null,
    state: running ? 'running' : state.lastError ? 'error' : 'idle',
    pending: pendingCount,
    lastLearnedAt: state.lastLearnedAt,
    lastAnalyzed: state.lastAnalyzed,
    lastError: state.lastError
  }
}

/** Pushes the current status to every window that may be showing it. */
function publishStatus(): KbMaintenanceStatus {
  const status = buildStatus()
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    try {
      win.webContents.send('kb-status', status)
    } catch (err) {
      console.warn('Failed to publish KB status:', err)
    }
  }
  return status
}

async function refreshStatus(): Promise<KbMaintenanceStatus> {
  pendingCount = await countPending()
  return publishStatus()
}

/** Latest status for the Knowledge view; recounts the queue before answering. */
export async function getKbMaintenanceStatus(): Promise<KbMaintenanceStatus> {
  pendingCount = await countPending()
  return buildStatus()
}

/* ---- Scheduling ---- */

function schedule(delayMs: number): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(
    () => {
      timer = null
      void runAutoPass()
    },
    Math.max(0, delayMs)
  )
  // A pending learning pass must never be the reason Electron stays alive.
  timer.unref()
}

/**
 * One bounded learning pass. Safe to call at any time: it re-reads the setting,
 * the model assignment and the queue, so a stale timer cannot do wrong work.
 */
async function runAutoPass(): Promise<void> {
  if (running) {
    // A write landed mid-pass; it is already counted by the pass's own recount,
    // but re-checking shortly after keeps the pacing honest either way.
    schedule(AUTO_DEBOUNCE_MS)
    return
  }
  if (!loadAppSettings().kbAutoMaintain) return
  if (!resolveRole('kb-maintenance')) {
    await refreshStatus()
    return
  }

  const unfed = await listUnfedConversations()
  pendingCount = unfed.filter((meta) => meta.source === 'chat' && !meta.kbFed).length
  const batch = selectAutoBatch(unfed)
  if (batch.length === 0) {
    publishStatus()
    return
  }

  const previous = loadKbState()
  const controller = new AbortController()
  activeRunController = controller
  running = true
  publishStatus()

  try {
    const result = await runExclusive(() =>
      runKbAnalysis(batch, { markFed: true, signal: controller.signal })
    )
    if (controller.signal.aborted) return

    const now = new Date().toISOString()
    pendingCount = await countPending()
    saveKbState({
      lastRunAt: now,
      lastLearnedAt: result.conversationsAnalyzed > 0 ? now : previous.lastLearnedAt,
      lastAnalyzed: result.conversationsAnalyzed,
      lastError: null,
      failedAttempts: 0
    })
    if (pendingCount > 0) schedule(AUTO_BACKLOG_INTERVAL_MS)
  } catch (err) {
    if (controller.signal.aborted) return
    const failedAttempts = previous.failedAttempts + 1
    const message = errorMessage(err)
    saveKbState({
      ...previous,
      lastRunAt: new Date().toISOString(),
      lastError: message,
      failedAttempts
    })
    schedule(autoFollowUpDelayMs({ pending: true, failed: true, failedAttempts }))
  } finally {
    activeRunController = null
    running = false
    publishStatus()
  }
}

/**
 * A conversation write is the only source of new learning material. Debounced
 * so a multi-turn chat is learned once it goes quiet, not after every answer.
 */
function handleConversationSaved(record: ConversationRecord): void {
  if (record.source !== 'chat' || record.kbFed) return
  if (!loadAppSettings().kbAutoMaintain) return
  if (!resolveRole('kb-maintenance')) return
  schedule(AUTO_DEBOUNCE_MS)
}

/**
 * Enabling automatic learning, or assigning the maintenance model, must take
 * effect without waiting for the next chat: re-check the queue on any save.
 */
function handleAppConfigChanged(): void {
  void refreshStatus()
    .then((status) => {
      if (!status.enabled || !status.configured || status.pending === 0) return
      schedule(AUTO_DEBOUNCE_MS)
    })
    .catch((err) => console.warn('Failed to react to a config change:', err))
}

/* ---- Lifecycle ---- */

export function startKbAutoMaintenance(): void {
  if (started) return
  started = true
  unsubscribeConversations = onConversationSaved(handleConversationSaved)
  unsubscribeConfig = onAppConfigChanged(handleAppConfigChanged)

  void (async () => {
    try {
      const status = await refreshStatus()
      if (!status.enabled || !status.configured || status.pending === 0) return
      schedule(startupDelayMs(loadKbState().lastRunAt, Date.now()))
    } catch (err) {
      console.warn('Failed to start automatic Knowledge Base maintenance:', err)
    }
  })()
}

export function stopKbAutoMaintenance(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  unsubscribeConversations?.()
  unsubscribeConversations = null
  unsubscribeConfig?.()
  unsubscribeConfig = null
  started = false
}

/* ---- Manual runs (Analyze / Re-Analyze) ---- */

/** Manual passes join the same queue, so an automatic pass cannot interleave. */
export function runKbAnalysisExclusive(
  metas: Array<Pick<ConversationMeta, 'id'>>,
  options: { markFed: boolean }
): Promise<KbRunResult> {
  return runExclusive(() => runKbAnalysis(metas, options))
}

/** Records a manual pass as a learning event so pacing and the UI stay truthful. */
export async function recordManualKbRun(conversationsAnalyzed: number): Promise<void> {
  if (conversationsAnalyzed > 0) {
    const now = new Date().toISOString()
    saveKbState({
      lastRunAt: now,
      lastLearnedAt: now,
      lastAnalyzed: conversationsAnalyzed,
      lastError: null,
      failedAttempts: 0
    })
  }
  await refreshStatus()
}

/* ---- Reset ---- */

/**
 * Reset wipes the profile while a pass may still be writing it. The wipe runs
 * inside the same queue as learning passes and aborts the in-flight one, so a
 * late response cannot resurrect the deleted prompt.
 */
export async function resetKbProfile(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  activeRunController?.abort()

  await runExclusive(async () => {
    resetKb()
    // Conversations stay on disk; clearing kbFed lets the profile be rebuilt.
    await resetKbFedFlags()
  })

  await refreshStatus()
  if (!loadAppSettings().kbAutoMaintain) return
  if (!resolveRole('kb-maintenance')) return
  schedule(AUTO_DEBOUNCE_MS)
}
