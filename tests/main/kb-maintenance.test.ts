import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationMeta, ConversationRecord } from '../../src/shared/conversation'
import { emptyKbState, type KbMaintenanceStatus, type KbPersistedState } from '../../src/shared/kb'

const h = vi.hoisted(() => {
  const events: string[] = []
  const windows = [
    {
      isDestroyed: (): boolean => false,
      webContents: {
        isDestroyed: (): boolean => false,
        send: (_channel: string, status: KbMaintenanceStatus): void => {
          events.push(`status:${status.state}`)
        }
      }
    }
  ]
  return {
    events,
    windows,
    loadAppSettings: vi.fn(),
    resolveRole: vi.fn(),
    onAppConfigChanged: vi.fn(),
    listUnfedConversations: vi.fn(),
    onConversationSaved: vi.fn(),
    resetKbFedFlags: vi.fn(),
    runKbAnalysis: vi.fn(),
    loadKbState: vi.fn(),
    saveKbState: vi.fn(),
    resetKb: vi.fn()
  }
})

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: (): unknown[] => h.windows }
}))
vi.mock('../../src/main/config', () => ({
  loadAppSettings: h.loadAppSettings,
  resolveRole: h.resolveRole,
  onAppConfigChanged: h.onAppConfigChanged
}))
vi.mock('../../src/main/conversations', () => ({
  listUnfedConversations: h.listUnfedConversations,
  onConversationSaved: h.onConversationSaved,
  resetKbFedFlags: h.resetKbFedFlags
}))
vi.mock('../../src/main/kb/run', () => ({ runKbAnalysis: h.runKbAnalysis }))
vi.mock('../../src/main/kb/store', () => ({
  loadKbState: h.loadKbState,
  saveKbState: h.saveKbState,
  resetKb: h.resetKb
}))

import {
  resetKbMaintenanceForTests,
  resetKbProfile,
  runKbAnalysisExclusive,
  startKbAutoMaintenance,
  stopKbAutoMaintenance
} from '../../src/main/kb/maintenance'
import {
  AUTO_BACKLOG_INTERVAL_MS,
  AUTO_DEBOUNCE_MS,
  AUTO_RETRY_BASE_MS
} from '../../src/main/kb/schedule'

const DEFAULT_SETTINGS = {
  hotkey: 'Ctrl+Shift+D',
  closeToTray: true,
  lookupContextMode: 'none',
  kbAutoMaintain: true
}

let state: KbPersistedState
let unfed: ConversationMeta[]
let savedListener: ((record: ConversationRecord) => void) | null

function chat(id: string, overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id,
    title: `Conversation ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    source: 'chat',
    kbFed: false,
    turnCount: 2,
    ...overrides
  }
}

function record(id: string, overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id,
    title: `Conversation ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    source: 'chat',
    state: { turns: [{ id: 1, role: 'user', content: 'Explain entropy.' }] },
    kbFed: false,
    ...overrides
  }
}

/** Let pending promise chains (startup probe, pass selection) settle. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-24T12:00:00.000Z'))
  resetKbMaintenanceForTests()
  h.events.length = 0
  state = emptyKbState()
  unfed = []
  savedListener = null

  h.loadAppSettings.mockReset().mockReturnValue({ ...DEFAULT_SETTINGS })
  h.resolveRole.mockReset().mockReturnValue({ connection: {}, model: 'test-model' })
  h.onAppConfigChanged.mockReset().mockReturnValue(() => undefined)
  h.listUnfedConversations
    .mockReset()
    .mockImplementation(async () => unfed.filter((meta) => !meta.kbFed))
  h.onConversationSaved.mockReset().mockImplementation((listener) => {
    savedListener = listener
    return () => {
      savedListener = null
    }
  })
  h.resetKbFedFlags.mockReset().mockImplementation(async () => {
    unfed = unfed.map((meta) => ({ ...meta, kbFed: false }))
  })
  h.runKbAnalysis.mockReset().mockImplementation(async (metas: Array<{ id: string }>) => {
    for (const meta of metas) {
      const target = unfed.find((candidate) => candidate.id === meta.id)
      if (target) target.kbFed = true
    }
    return { newPrompt: 'learned prompt', keywords: [], conversationsAnalyzed: metas.length }
  })
  h.loadKbState.mockReset().mockImplementation(() => ({ ...state }))
  h.saveKbState.mockReset().mockImplementation((next: KbPersistedState) => {
    state = { ...next }
  })
  h.resetKb.mockReset().mockImplementation(() => {
    h.events.push('wipe')
    state = emptyKbState()
  })
})

afterEach(() => {
  resetKbMaintenanceForTests()
  vi.useRealTimers()
})

describe('automatic KB pass scheduling', () => {
  it('does not start a pass twice when two timers fire mid-scan', async () => {
    startKbAutoMaintenance()
    await settle()
    expect(savedListener).not.toBeNull()

    unfed = [chat('chat_a')]
    const scan = Promise.withResolvers<ConversationMeta[]>()
    h.listUnfedConversations.mockImplementationOnce(() => scan.promise)

    savedListener?.(record('chat_a'))
    await vi.advanceTimersByTimeAsync(AUTO_DEBOUNCE_MS)
    expect(h.runKbAnalysis).not.toHaveBeenCalled()

    // A second save lands while the first pass is still scanning the queue.
    savedListener?.(record('chat_a'))
    await vi.advanceTimersByTimeAsync(AUTO_DEBOUNCE_MS)
    expect(h.runKbAnalysis).not.toHaveBeenCalled()

    scan.resolve(unfed)
    await settle()

    expect(h.runKbAnalysis).toHaveBeenCalledTimes(1)
  })

  it('keeps a learning event recorded while a failing pass was queued', async () => {
    startKbAutoMaintenance()
    await settle()
    unfed = [chat('chat_a')]

    h.runKbAnalysis.mockImplementationOnce(async () => {
      // A manual pass finished between selection and this provider failure.
      state = {
        lastRunAt: '2026-10-23T00:00:00.000Z',
        lastLearnedAt: '2026-10-22T00:00:00.000Z',
        lastAnalyzed: 7,
        lastError: null,
        failedAttempts: 2
      }
      throw new Error('API error 503')
    })

    savedListener?.(record('chat_a'))
    await vi.advanceTimersByTimeAsync(AUTO_DEBOUNCE_MS)

    expect(state.lastError).toBe('API error 503')
    expect(state.failedAttempts).toBe(3)
    expect(state.lastLearnedAt).toBe('2026-10-22T00:00:00.000Z')
    expect(state.lastAnalyzed).toBe(7)
  })

  it('keeps the latest learning timestamp when a pass analyzes nothing', async () => {
    startKbAutoMaintenance()
    await settle()
    unfed = [chat('chat_a')]

    h.runKbAnalysis.mockImplementationOnce(async () => {
      state = {
        lastRunAt: '2026-10-23T00:00:00.000Z',
        lastLearnedAt: '2026-10-22T00:00:00.000Z',
        lastAnalyzed: 7,
        lastError: null,
        failedAttempts: 0
      }
      return { newPrompt: 'prompt', keywords: [], conversationsAnalyzed: 0 }
    })

    savedListener?.(record('chat_a'))
    await vi.advanceTimersByTimeAsync(AUTO_DEBOUNCE_MS)

    expect(state.lastLearnedAt).toBe('2026-10-22T00:00:00.000Z')
    expect(state.lastError).toBeNull()
  })

  it('does not schedule work when the startup probe finishes after shutdown', async () => {
    unfed = [chat('chat_a')]
    const scan = Promise.withResolvers<ConversationMeta[]>()
    h.listUnfedConversations.mockImplementationOnce(() => scan.promise)

    startKbAutoMaintenance()
    stopKbAutoMaintenance()
    scan.resolve(unfed)
    await settle()

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.runKbAnalysis).not.toHaveBeenCalled()
  })

  it('ignores a startup probe left over from a previous start', async () => {
    const staleScan = Promise.withResolvers<ConversationMeta[]>()
    h.listUnfedConversations.mockImplementationOnce(() => staleScan.promise)

    startKbAutoMaintenance()
    stopKbAutoMaintenance()

    h.listUnfedConversations.mockResolvedValueOnce([])
    startKbAutoMaintenance()
    await settle()

    staleScan.resolve([chat('chat_a')])
    await settle()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts an in-flight pass, wipes state and then schedules a rebuild', async () => {
    startKbAutoMaintenance()
    await settle()
    unfed = [chat('chat_a')]

    const pass = Promise.withResolvers<string>()
    let signal: AbortSignal | undefined
    h.runKbAnalysis.mockImplementationOnce((_metas, options: { signal?: AbortSignal }) => {
      signal = options.signal
      signal?.addEventListener('abort', () => {
        pass.reject(new Error('Generation stopped.'))
      })
      return pass.promise
    })

    savedListener?.(record('chat_a'))
    await vi.advanceTimersByTimeAsync(AUTO_DEBOUNCE_MS)
    expect(signal).toBeDefined()
    expect(h.runKbAnalysis).toHaveBeenCalledTimes(1)

    const reset = resetKbProfile()
    await reset

    expect(signal?.aborted).toBe(true)
    expect(h.resetKb).toHaveBeenCalledTimes(1)
    // Aborted work is neither a learning event nor a failure.
    expect(h.saveKbState).not.toHaveBeenCalled()
    // No pre-wipe idle snapshot may be published between the abort and the wipe.
    const passAt = h.events.lastIndexOf('status:running')
    const wipeAt = h.events.indexOf('wipe')
    expect(passAt).toBeGreaterThanOrEqual(0)
    expect(wipeAt).toBeGreaterThan(passAt)
    expect(h.events.slice(passAt + 1, wipeAt)).not.toContain('status:idle')
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(AUTO_DEBOUNCE_MS)
    expect(h.runKbAnalysis).toHaveBeenCalledTimes(2)
  })

  it('discards a queue scan that began before a reset', async () => {
    startKbAutoMaintenance()
    await settle()
    unfed = [chat('chat_a')]

    const scan = Promise.withResolvers<ConversationMeta[]>()
    h.listUnfedConversations.mockImplementationOnce(() => scan.promise)

    savedListener?.(record('chat_a'))
    await vi.advanceTimersByTimeAsync(AUTO_DEBOUNCE_MS)

    const reset = resetKbProfile()
    scan.resolve(unfed)
    await reset
    await settle()

    expect(h.runKbAnalysis).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(AUTO_DEBOUNCE_MS)
    expect(h.runKbAnalysis).toHaveBeenCalledTimes(1)
  })

  it('runs exactly one debounced pass and records the learning event', async () => {
    startKbAutoMaintenance()
    await settle()
    expect(savedListener).not.toBeNull()
    expect(vi.getTimerCount()).toBe(0)

    unfed = [chat('chat_a')]
    savedListener?.(record('chat_a'))
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(AUTO_DEBOUNCE_MS - 1)
    expect(h.runKbAnalysis).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(h.runKbAnalysis).toHaveBeenCalledTimes(1)
    expect(h.runKbAnalysis.mock.calls[0][0].map((meta) => meta.id)).toEqual(['chat_a'])
    expect(state.lastLearnedAt).toBe(new Date().toISOString())
    expect(state.lastAnalyzed).toBe(1)
    expect(state.lastError).toBeNull()
    expect(state.failedAttempts).toBe(0)
  })

  it('coalesces a second save inside the debounce window', async () => {
    startKbAutoMaintenance()
    await settle()
    unfed = [chat('chat_a')]

    savedListener?.(record('chat_a'))
    await vi.advanceTimersByTimeAsync(10_000)
    savedListener?.(record('chat_a'))
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(AUTO_DEBOUNCE_MS - 1)
    expect(h.runKbAnalysis).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.runKbAnalysis).toHaveBeenCalledTimes(1)
  })

  it('drains a backlog on the 45s follow-up timer', async () => {
    startKbAutoMaintenance()
    await settle()
    unfed = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => chat(id))

    savedListener?.(record('a'))
    await vi.advanceTimersByTimeAsync(AUTO_DEBOUNCE_MS)
    expect(h.runKbAnalysis).toHaveBeenCalledTimes(1)
    expect(h.runKbAnalysis.mock.calls[0][0].map((meta) => meta.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(AUTO_BACKLOG_INTERVAL_MS - 1)
    expect(h.runKbAnalysis).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.runKbAnalysis).toHaveBeenCalledTimes(2)
    expect(h.runKbAnalysis.mock.calls[1][0].map((meta) => meta.id)).toEqual(['e', 'f'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('records a failure and retries with exponential backoff', async () => {
    startKbAutoMaintenance()
    await settle()
    unfed = [chat('chat_a')]
    state = { ...emptyKbState(), lastLearnedAt: '2026-10-20T00:00:00.000Z' }

    h.runKbAnalysis.mockRejectedValueOnce(new Error('API error 500'))
    savedListener?.(record('chat_a'))
    await vi.advanceTimersByTimeAsync(AUTO_DEBOUNCE_MS)

    expect(state.lastError).toBe('API error 500')
    expect(state.failedAttempts).toBe(1)
    expect(state.lastLearnedAt).toBe('2026-10-20T00:00:00.000Z')
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(AUTO_RETRY_BASE_MS - 1)
    expect(h.runKbAnalysis).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.runKbAnalysis).toHaveBeenCalledTimes(2)
    expect(state.lastError).toBeNull()
    expect(state.failedAttempts).toBe(0)
  })

  it('does nothing when automatic learning is disabled', async () => {
    h.loadAppSettings.mockReturnValue({ ...DEFAULT_SETTINGS, kbAutoMaintain: false })
    unfed = [chat('chat_a')]

    startKbAutoMaintenance()
    await settle()
    expect(vi.getTimerCount()).toBe(0)

    savedListener?.(record('chat_a'))
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.runKbAnalysis).not.toHaveBeenCalled()
  })

  it('does nothing when the maintenance role is unassigned', async () => {
    h.resolveRole.mockReturnValue(null)
    unfed = [chat('chat_a')]

    startKbAutoMaintenance()
    await settle()
    expect(vi.getTimerCount()).toBe(0)

    savedListener?.(record('chat_a'))
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.runKbAnalysis).not.toHaveBeenCalled()
  })

  it('re-checks the setting when an already-scheduled timer fires', async () => {
    startKbAutoMaintenance()
    await settle()
    unfed = [chat('chat_a')]

    savedListener?.(record('chat_a'))
    h.loadAppSettings.mockReturnValue({ ...DEFAULT_SETTINGS, kbAutoMaintain: false })
    await vi.advanceTimersByTimeAsync(AUTO_DEBOUNCE_MS)

    expect(h.runKbAnalysis).not.toHaveBeenCalled()
  })

  it('keeps the shared queue alive after a rejected task', async () => {
    h.runKbAnalysis.mockRejectedValueOnce(new Error('provider exploded'))
    await expect(runKbAnalysisExclusive([{ id: 'chat_a' }], { markFed: true })).rejects.toThrow(
      'provider exploded'
    )

    h.runKbAnalysis.mockResolvedValueOnce({
      newPrompt: 'recovered',
      keywords: [],
      conversationsAnalyzed: 1
    })
    await expect(
      runKbAnalysisExclusive([{ id: 'chat_b' }], { markFed: true })
    ).resolves.toMatchObject({ newPrompt: 'recovered' })
  })

  it('ignores saves that carry no learning signal', async () => {
    startKbAutoMaintenance()
    await settle()

    savedListener?.(record('chat_a', { kbFed: true }))
    savedListener?.(record('lookup_a', { source: 'lookup' }))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not let startup pacing defer a pass scheduled by a save', async () => {
    // The previous run was a minute ago, so the startup probe would wait ~9 minutes.
    state = { ...emptyKbState(), lastRunAt: '2026-10-24T11:59:00.000Z' }
    const scan = Promise.withResolvers<ConversationMeta[]>()
    h.listUnfedConversations.mockImplementationOnce(() => scan.promise)

    startKbAutoMaintenance()
    unfed = [chat('chat_a')]
    savedListener?.(record('chat_a'))
    expect(vi.getTimerCount()).toBe(1)

    scan.resolve(unfed)
    await settle()

    await vi.advanceTimersByTimeAsync(AUTO_DEBOUNCE_MS)
    expect(h.runKbAnalysis).toHaveBeenCalledTimes(1)
  })
})
