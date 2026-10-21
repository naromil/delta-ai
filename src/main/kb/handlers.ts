import { ipcMain } from 'electron'
import { loadKbPrompt, saveKbPrompt, loadKbKeywords, saveKbKeywords } from './store'
import { callProvider } from '../provider'
import {
  loadConversation,
  listConversations,
  listUnfedConversations,
  markConversationKbFed
} from '../conversations'
import { buildSingleMaterial, buildKbAnalysisMessages, buildKbKeywordMessages } from './analysis'
import type { CategorizedKeyword, KeywordCategory } from '../../shared/models'
import { MAX_KEYWORDS_PER_CATEGORY } from '../../shared/models'

function parseKeywords(raw: string): CategorizedKeyword[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(.+?)\s*\[(topic|knowledge_area|learning_preference)\]$/)
      if (!match) return null
      return { keyword: match[1].trim(), category: match[2] as KeywordCategory, count: 1 }
    })
    .filter((kw): kw is CategorizedKeyword => kw !== null)
}

function mergeKeywords(
  existing: CategorizedKeyword[],
  incoming: CategorizedKeyword[]
): CategorizedKeyword[] {
  const map = new Map<string, CategorizedKeyword>()
  for (const kw of existing) {
    const key = `${kw.category}:${kw.keyword.toLowerCase()}`
    map.set(key, { ...kw })
  }
  for (const kw of incoming) {
    const key = `${kw.category}:${kw.keyword.toLowerCase()}`
    const prev = map.get(key)
    if (prev) {
      prev.count += 1
    } else {
      map.set(key, { ...kw })
    }
  }
  return Array.from(map.values())
}

function trimByCategory(keywords: CategorizedKeyword[]): CategorizedKeyword[] {
  const categories: KeywordCategory[] = ['topic', 'knowledge_area', 'learning_preference']
  const result: CategorizedKeyword[] = []
  for (const cat of categories) {
    const group = keywords
      .filter((kw) => kw.category === cat)
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_KEYWORDS_PER_CATEGORY)
    result.push(...group)
  }
  return result
}

async function analyzeConversations(
  metas: Array<{ id: string }>,
  markFed: boolean
): Promise<{ newPrompt: string; keywords: CategorizedKeyword[]; conversationsAnalyzed: number }> {
  let currentPrompt = loadKbPrompt()
  let analyzed = 0

  for (const meta of metas) {
    const record = await loadConversation(meta.id)
    if (!record) continue

    const material = buildSingleMaterial(record)
    const analysisMessages = buildKbAnalysisMessages(currentPrompt, material)
    currentPrompt = await callProvider(analysisMessages, 'kb-maintenance')
    analyzed++

    if (markFed) {
      await markConversationKbFed(meta.id)
    }
  }

  if (analyzed === 0) {
    return {
      newPrompt: currentPrompt,
      keywords: loadKbKeywords(),
      conversationsAnalyzed: 0
    }
  }

  saveKbPrompt(currentPrompt)

  const existingKeywords = loadKbKeywords()
  const keywordMessages = buildKbKeywordMessages(currentPrompt, existingKeywords)
  const rawKeywords = await callProvider(keywordMessages, 'kb-maintenance')
  const parsed = parseKeywords(rawKeywords)
  const merged = mergeKeywords(existingKeywords, parsed)
  const trimmed = trimByCategory(merged)
  saveKbKeywords(trimmed)

  return {
    newPrompt: currentPrompt,
    keywords: trimmed,
    conversationsAnalyzed: analyzed
  }
}

export function registerKbIpcHandlers(): void {
  ipcMain.handle('kb-load-prompt', () => {
    return { prompt: loadKbPrompt(), keywords: loadKbKeywords() }
  })

  ipcMain.handle('kb-analyze', async () => {
    const unfed = await listUnfedConversations()
    return analyzeConversations(unfed, true)
  })

  ipcMain.handle('kb-reanalyze', async (_event, n: number) => {
    const all = await listConversations()
    return analyzeConversations(all.slice(0, n), false)
  })
}
