import { join } from 'path'
import { readFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { app } from 'electron'
import { emptyKbState, normalizeKbState, type KbPersistedState } from '../../shared/kb'
import { LEARNING_PREFERENCES_FILE } from '../../shared/prompts'
import { memoriesDir, writeMemory } from '../memory/store'
import { writeFileAtomicSync } from '../services/atomic-file'

/* ---- KB directory ---- */
function kbDir(): string {
  const dir = join(app.getPath('userData'), 'kb')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/* ---- Maintenance state ---- */
export function loadKbState(): KbPersistedState {
  let statePath = ''
  try {
    statePath = join(kbDir(), 'state.json')
    if (!existsSync(statePath)) return emptyKbState()
    return normalizeKbState(JSON.parse(readFileSync(statePath, 'utf-8')))
  } catch (err) {
    if (statePath) console.warn(`Failed to read KB state at ${statePath}:`, err)
    return emptyKbState()
  }
}

export function saveKbState(state: KbPersistedState): void {
  writeFileAtomicSync(join(kbDir(), 'state.json'), JSON.stringify(normalizeKbState(state), null, 2))
}

/* ---- Legacy prompt ---- */

/**
 * Carries the learned prompt from older versions into the document base, once. The old
 * file is renamed rather than checked again, so a later "forget this" cannot bring it back.
 */
export function migrateLegacyKbPrompt(): void {
  try {
    const legacyPath = join(kbDir(), 'prompt.txt')
    if (!existsSync(legacyPath)) return
    const root = memoriesDir()
    const learned = readFileSync(legacyPath, 'utf-8').trim()
    if (learned && !existsSync(join(root, LEARNING_PREFERENCES_FILE))) {
      writeMemory(root, LEARNING_PREFERENCES_FILE, `${learned}\n`)
    }
    renameSync(legacyPath, join(kbDir(), 'prompt.migrated.txt'))
  } catch (err) {
    console.warn('Failed to move the learned prompt into memories:', err)
  }
}
