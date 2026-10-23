import { join } from 'path'
import { readFileSync, existsSync, mkdirSync, rmSync } from 'fs'
import { app } from 'electron'
import type { CategorizedKeyword } from '../../shared/models'
import { writeFileAtomicSync } from '../services/atomic-file'

/* ---- KB directory ---- */
function kbDir(): string {
  const dir = join(app.getPath('userData'), 'kb')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/* ---- Prompt ---- */
export function loadKbPrompt(): string {
  let promptPath = ''
  try {
    promptPath = join(kbDir(), 'prompt.txt')
    if (!existsSync(promptPath)) return ''
    return readFileSync(promptPath, 'utf-8')
  } catch (err) {
    if (promptPath) console.warn(`Failed to read KB prompt at ${promptPath}:`, err)
    return ''
  }
}

export function saveKbPrompt(content: string): void {
  writeFileAtomicSync(join(kbDir(), 'prompt.txt'), content)
}

/* ---- Keywords ---- */
export function loadKbKeywords(): CategorizedKeyword[] {
  let keywordsPath = ''
  try {
    keywordsPath = join(kbDir(), 'keywords.json')
    if (!existsSync(keywordsPath)) return []
    const raw = readFileSync(keywordsPath, 'utf-8')
    return JSON.parse(raw)
  } catch (err) {
    if (keywordsPath) console.warn(`Failed to read KB keywords at ${keywordsPath}:`, err)
    return []
  }
}

export function saveKbKeywords(keywords: CategorizedKeyword[]): void {
  writeFileAtomicSync(join(kbDir(), 'keywords.json'), JSON.stringify(keywords))
}

/** Delete the learned prompt and keywords; the next analysis starts from scratch. */
export function resetKb(): void {
  for (const name of ['prompt.txt', 'keywords.json']) {
    rmSync(join(kbDir(), name), { force: true })
  }
}
