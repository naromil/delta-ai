import { ipcMain } from 'electron'
import { loadKbPrompt, saveKbPrompt, loadKbKeywords } from './store'
import { listConversations, listUnfedConversations } from '../conversations'
import {
  getKbMaintenanceStatus,
  recordManualKbRun,
  resetKbProfile,
  runKbAnalysisExclusive
} from './maintenance'

/**
 * Manual controls over the same pipeline the automatic loop runs. The
 * Knowledge view keeps them for deliberate re-learning; normal use never
 * needs them.
 */
export function registerKbIpcHandlers(): void {
  ipcMain.handle('kb-load-prompt', () => {
    return { prompt: loadKbPrompt(), keywords: loadKbKeywords() }
  })

  ipcMain.handle('kb-save-prompt', (_event, content: string) => {
    saveKbPrompt(typeof content === 'string' ? content : '')
    return { prompt: loadKbPrompt(), keywords: loadKbKeywords() }
  })

  ipcMain.handle('kb-get-status', () => getKbMaintenanceStatus())

  ipcMain.handle('kb-reset', async () => {
    // The wipe is queued behind any running pass and clears kbFed, so the
    // retained history can be learned again.
    await resetKbProfile()
    return { prompt: loadKbPrompt(), keywords: loadKbKeywords() }
  })

  ipcMain.handle('kb-analyze', async () => {
    const unfed = await listUnfedConversations()
    const result = await runKbAnalysisExclusive(unfed, { markFed: true })
    await recordManualKbRun(result.conversationsAnalyzed)
    return result
  })

  ipcMain.handle('kb-reanalyze', async (_event, n: number) => {
    const all = await listConversations()
    const result = await runKbAnalysisExclusive(all.slice(0, n), { markFed: false })
    await recordManualKbRun(result.conversationsAnalyzed)
    return result
  })
}
