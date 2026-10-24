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
  startKbAutoMaintenance,
  stopKbAutoMaintenance
} from '../../src/main/kb/maintenance'
import { AUTO_DEBOUNCE_MS } from '../../src/main/kb/schedule'

const DEFAULT_SETTINGS = {
  hotkey: 'Ctrl+Shift+D',
  closeToTray: true,
  lookupContextMode: 'clipboard',
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
  h.resetKb
    .mockReset()
    .mockImplementation(() => {
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
})
