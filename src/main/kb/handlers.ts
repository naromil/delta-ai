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
import { parseKeywords, mergeKeywords, trimByCategory } from './keywords'
import type { CategorizedKeyword } from '../../shared/models'

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
    saveKbPrompt(currentPrompt)
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
