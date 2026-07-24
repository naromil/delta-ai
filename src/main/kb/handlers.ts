import { ipcMain } from 'electron'
import { loadKbPrompt, saveKbPrompt } from '../config'
import { callProvider } from '../provider'
import { listConversations, listUnfedConversations, markConversationKbFed } from '../conversations'
import { buildKbTranscripts, buildKbAnalysisMessages } from './analysis'

export function registerKbIpcHandlers(): void {
  ipcMain.handle('kb-load-prompt', () => {
    return { prompt: loadKbPrompt() }
  })

  ipcMain.handle('kb-analyze', async () => {
    const unfed = await listUnfedConversations()
    if (unfed.length === 0) {
      return { newPrompt: loadKbPrompt(), conversationsAnalyzed: 0 }
    }

    const transcripts = await buildKbTranscripts(unfed)
    const currentPrompt = loadKbPrompt()
    const messages = buildKbAnalysisMessages(currentPrompt, transcripts)

    const newPrompt = await callProvider(messages, 'kb-maintenance')
    saveKbPrompt(newPrompt)

    for (const meta of unfed) {
      await markConversationKbFed(meta.id)
    }

    return { newPrompt, conversationsAnalyzed: unfed.length }
  })

  ipcMain.handle('kb-reanalyze', async () => {
    const all = await listConversations()
    if (all.length === 0) {
      return { newPrompt: loadKbPrompt(), conversationsAnalyzed: 0 }
    }

    const transcripts = await buildKbTranscripts(all)
    const currentPrompt = loadKbPrompt()
    const messages = buildKbAnalysisMessages(currentPrompt, transcripts)

    const newPrompt = await callProvider(messages, 'kb-maintenance')
    saveKbPrompt(newPrompt)

    return { newPrompt, conversationsAnalyzed: all.length }
  })
}
