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

let timer: NodeJS.Timeout | undefined
let running = false
let started = false
let pendingCount = 0
let queue: Promise<unknown> = Promise.resolve()
let unsubscribeConversations: (() => void) | null = null
let unsubscribeConfig: (() => void) | null = null
let activeRunController: AbortController | null = null
/** Invalidates startup probes and queue scans that straddle a stop or reset. */
let lifecycle = 0

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
  clearTimeout(timer)
  timer = setTimeout(
    () => {
      timer = undefined
      void runAutoPass().catch((err) => console.warn('Automatic KB pass failed:', err))
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

  // Claim the pass before the first await: two timer callbacks must never both
  // select the same batch and enqueue overlapping runs.
  const generation = lifecycle
  running = true
  let controller: AbortController | null = null

  try {
    const unfed = await listUnfedConversations()
    // A reset started while the queue was being read; it schedules its own rebuild.
    if (generation !== lifecycle) return
    pendingCount = unfed.filter((meta) => meta.source === 'chat' && !meta.kbFed).length
    const batch = selectAutoBatch(unfed)
    if (batch.length === 0) return

    const runController = new AbortController()
    controller = runController
    activeRunController = runController
    publishStatus()

    const result = await runExclusive(() =>
      runKbAnalysis(batch, { markFed: true, signal: runController.signal })
    )
    if (runController.signal.aborted || generation !== lifecycle) return

    const now = new Date().toISOString()
    pendingCount = await countPending()
    // The reset's wipe may have run while the queue was recounted; never write
    // pacing state back over it.
    if (runController.signal.aborted || generation !== lifecycle) return
    // A manual pass may have finished while this pass waited in the queue; keep
    // its learning event instead of restoring the snapshot taken before it.
    const state = loadKbState()
    saveKbState({
      lastRunAt: now,
      lastLearnedAt: result.conversationsAnalyzed > 0 ? now : state.lastLearnedAt,
      lastAnalyzed: result.conversationsAnalyzed,
      lastError: null,
      failedAttempts: 0
    })
    if (pendingCount > 0) schedule(AUTO_BACKLOG_INTERVAL_MS)
  } catch (err) {
    if (controller?.signal.aborted || generation !== lifecycle) return
    // Read the state as it is *now*: another pass may have finished while this
    // one waited in the queue, and its learning event must not be overwritten.
    const state = loadKbState()
    const failedAttempts = state.failedAttempts + 1
    const message = errorMessage(err)
    saveKbState({
      ...state,
      lastRunAt: new Date().toISOString(),
      lastError: message,
      failedAttempts
    })
    schedule(autoFollowUpDelayMs({ pending: true, failed: true, failedAttempts }))
  } finally {
    if (activeRunController === controller) activeRunController = null
    running = false
    // An aborted pass must not publish a snapshot of the profile that a reset is
    // about to delete; `resetKbProfile` publishes the post-wipe state instead.
    if (generation === lifecycle && !controller?.signal.aborted) publishStatus()
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
      if (!started || !status.enabled || !status.configured || status.pending === 0) return
      schedule(AUTO_DEBOUNCE_MS)
    })
    .catch((err) => console.warn('Failed to react to a config change:', err))
}

/* ---- Lifecycle ---- */

export function startKbAutoMaintenance(): void {
  if (started) return
  started = true
  const token = ++lifecycle
  unsubscribeConversations = onConversationSaved(handleConversationSaved)
  unsubscribeConfig = onAppConfigChanged(handleAppConfigChanged)

  void (async () => {
    try {
      const status = await refreshStatus()
      // A stop (or stop/start pair) may have landed while the probe ran.
      if (token !== lifecycle || !started) return
      if (!status.enabled || !status.configured || status.pending === 0) return
      schedule(startupDelayMs(loadKbState().lastRunAt, Date.now()))
    } catch (err) {
      console.warn('Failed to start automatic Knowledge Base maintenance:', err)
    }
  })()
}

export function stopKbAutoMaintenance(): void {
  lifecycle++
  if (timer !== undefined) {
    clearTimeout(timer)
    timer = undefined
  }
  // A quitting app must not keep a provider request alive.
  activeRunController?.abort()
  unsubscribeConversations?.()
  unsubscribeConversations = null
  unsubscribeConfig?.()
  unsubscribeConfig = null
  started = false
}

/** Test-only: drop timers, subscriptions and queue state between isolated cases. */
export function resetKbMaintenanceForTests(): void {
  stopKbAutoMaintenance()
  queue = Promise.resolve()
  running = false
  pendingCount = 0
  activeRunController = null
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
  // Invalidate any pass that is still scanning the queue: the wipe below runs
  // first, and the reset schedules its own rebuild.
  lifecycle++
  if (timer !== undefined) {
    clearTimeout(timer)
    timer = undefined
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
