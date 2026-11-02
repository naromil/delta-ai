import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyKbState } from '../../src/shared/kb'

const paths = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: (): string => paths.userData }
}))

import { loadKbState, migrateLegacyKbPrompt, saveKbState } from '../../src/main/kb/store'

describe('KB store', () => {
  beforeEach(() => {
    paths.userData = mkdtempSync(join(tmpdir(), 'delta-ai-kb-'))
  })

  afterEach(() => {
    rmSync(paths.userData, { recursive: true, force: true })
  })

  it('starts empty', () => {
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

  describe('migrateLegacyKbPrompt', () => {
    function writeLegacy(content: string): void {
      mkdirSync(join(paths.userData, 'kb'), { recursive: true })
      writeFileSync(join(paths.userData, 'kb', 'prompt.txt'), content)
    }
    const preferences = (): string => join(paths.userData, 'memories', 'index-learning.md')

    it('moves the learned prompt into the document base', () => {
      writeLegacy('Prefers worked examples.\n')
      migrateLegacyKbPrompt()
      expect(readFileSync(preferences(), 'utf-8')).toBe('Prefers worked examples.\n')
      expect(existsSync(join(paths.userData, 'kb', 'prompt.txt'))).toBe(false)
      expect(existsSync(join(paths.userData, 'kb', 'prompt.migrated.txt'))).toBe(true)
    })

    it('does not bring preferences back after the user had them deleted', () => {
      writeLegacy('Prefers worked examples.')
      migrateLegacyKbPrompt()
      rmSync(preferences())
      migrateLegacyKbPrompt()
      expect(existsSync(preferences())).toBe(false)
    })

    it('never overwrites preferences the curator already wrote', () => {
      writeLegacy('old')
      mkdirSync(join(paths.userData, 'memories'), { recursive: true })
      writeFileSync(preferences(), 'newer')
      migrateLegacyKbPrompt()
      expect(readFileSync(preferences(), 'utf-8')).toBe('newer')
    })

    it('creates nothing for an empty prompt or a fresh install', () => {
      migrateLegacyKbPrompt()
      writeLegacy('  \n')
      migrateLegacyKbPrompt()
      expect(existsSync(preferences())).toBe(false)
    })
  })
})
