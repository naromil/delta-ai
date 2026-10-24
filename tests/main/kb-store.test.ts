import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyKbState } from '../../src/shared/kb'

const paths = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: (): string => paths.userData }
}))

import {
  loadKbKeywords,
  loadKbPrompt,
  loadKbState,
  resetKb,
  saveKbKeywords,
  saveKbPrompt,
  saveKbState
} from '../../src/main/kb/store'

describe('KB store', () => {
  beforeEach(() => {
    paths.userData = mkdtempSync(join(tmpdir(), 'delta-ai-kb-'))
  })

  afterEach(() => {
    rmSync(paths.userData, { recursive: true, force: true })
  })

  it('starts empty', () => {
    expect(loadKbPrompt()).toBe('')
    expect(loadKbKeywords()).toEqual([])
    expect(loadKbState()).toEqual(emptyKbState())
  })

  it('round-trips the maintenance state', () => {
    saveKbState({
      lastRunAt: '2026-10-24T12:00:00.000Z',
      lastLearnedAt: '2026-10-24T11:00:00.000Z',
      lastAnalyzed: 4,
      lastError: null,
      failedAttempts: 0
    })
    expect(loadKbState()).toEqual({
      lastRunAt: '2026-10-24T12:00:00.000Z',
      lastLearnedAt: '2026-10-24T11:00:00.000Z',
      lastAnalyzed: 4,
      lastError: null,
      failedAttempts: 0
    })
  })

  it('survives a corrupt state file', () => {
    saveKbState(emptyKbState())
    writeFileSync(join(paths.userData, 'kb', 'state.json'), '{ not json')
    expect(loadKbState()).toEqual(emptyKbState())
  })

  it('reset deletes the prompt, keywords and pacing state together', () => {
    saveKbPrompt('a learned profile')
    saveKbKeywords([{ keyword: 'chemistry', category: 'topic', count: 2 }])
    saveKbState({ ...emptyKbState(), lastRunAt: '2026-10-24T12:00:00.000Z' })

    resetKb()

    expect(loadKbPrompt()).toBe('')
    expect(loadKbKeywords()).toEqual([])
    expect(loadKbState()).toEqual(emptyKbState())
    // The directory survives; only the files are removed.
    expect(() => readFileSync(join(paths.userData, 'kb', 'prompt.txt'))).toThrow()
  })
})
