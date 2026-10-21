import { join } from 'path'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { app } from 'electron'
import type { CategorizedKeyword } from '../../shared/models'

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
  const promptPath = join(kbDir(), 'prompt.txt')
  writeFileSync(promptPath, content, 'utf-8')
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
  const keywordsPath = join(kbDir(), 'keywords.json')
  writeFileSync(keywordsPath, JSON.stringify(keywords), 'utf-8')
}
