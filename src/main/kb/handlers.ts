import { ipcMain } from 'electron'
import { loadKbPrompt, saveKbPrompt } from '../config'
import { callProvider } from '../provider'
import {
  loadConversation,
  listConversations,
  listUnfedConversations,
  markConversationKbFed
} from '../conversations'
import { buildSingleMaterial, buildKbAnalysisMessages } from './analysis'

async function analyzeConversations(
  metas: Array<{ id: string }>,
  markFed: boolean
): Promise<{ newPrompt: string; conversationsAnalyzed: number }> {
  let currentPrompt = loadKbPrompt()
  let analyzed = 0

  for (const meta of metas) {
    const record = await loadConversation(meta.id)
    if (!record) continue

    const material = buildSingleMaterial(record)
    const messages = buildKbAnalysisMessages(currentPrompt, [material])
    const newPrompt = await callProvider(messages, 'kb-maintenance')

    currentPrompt = newPrompt
    analyzed++

    if (markFed) {
      await markConversationKbFed(meta.id)
    }
  }

  if (analyzed > 0) {
    saveKbPrompt(currentPrompt)
  }

  return { newPrompt: currentPrompt, conversationsAnalyzed: analyzed }
}

export function registerKbIpcHandlers(): void {
  ipcMain.handle('kb-load-prompt', () => {
    return { prompt: loadKbPrompt() }
  })

  ipcMain.handle('kb-analyze', async () => {
    const unfed = await listUnfedConversations()
    return analyzeConversations(unfed, true)
  })

  ipcMain.handle('kb-reanalyze', async () => {
    const all = await listConversations()
    return analyzeConversations(all, false)
  })
}
