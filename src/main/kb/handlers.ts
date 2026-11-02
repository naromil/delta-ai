import { ipcMain } from 'electron'
import { listConversations, listUnfedConversations } from '../conversations'
import { getKbMaintenanceStatus, recordManualKbRun, runKbAnalysisExclusive } from './maintenance'

/**
 * Manual controls over the same pipeline the automatic loop runs. The
 * Knowledge view keeps them for deliberate re-learning; normal use never
 * needs them.
 */
export function registerKbIpcHandlers(): void {
  ipcMain.handle('kb-get-status', () => getKbMaintenanceStatus())

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
