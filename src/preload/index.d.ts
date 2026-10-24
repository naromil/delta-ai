import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  ConversationState,
  ConversationRecord,
  ConversationMeta,
  ConversationSearchResult
} from '../shared/conversation'
import type { CategorizedKeyword, Connection } from '../shared/models'
import type { KbMaintenanceStatus } from '../shared/kb'
import type { ModelCatalogState } from '../shared/model-catalog'
import type { ConnectionTestResult, DiscoveredModels } from '../main/services/model-discovery'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      loadModelConfig: () => Promise<unknown>
      saveModelConfig: (config: unknown) => Promise<{ success: boolean; error?: string }>
      loadModelCatalog: (force?: boolean) => Promise<ModelCatalogState>
      listProviderModels: (connection: Connection) => Promise<DiscoveredModels>
      testProviderConnection: (
        connection: Connection,
        probeModel?: string
      ) => Promise<ConnectionTestResult>
      loadSettings: () => Promise<{
        hotkey: string
        closeToTray: boolean
        lookupContextMode: string
        kbAutoMaintain: boolean
      }>
      saveSettings: (settings: {
        hotkey: string
        closeToTray: boolean
        lookupContextMode: string
        kbAutoMaintain: boolean
      }) => Promise<{ success: boolean; hotkeyMode: 'global' | 'local'; error?: string }>
      getHotkeyStatus: () => Promise<{ accelerator: string; mode: 'global' | 'local' }>
      setHotkeyCaptureActive: (active: boolean) => void

      /* Lookup channels */
      lookupOnContext: (cb: (state: { status: string; text: string; hint: string }) => void) => void
      lookupOnError: (cb: (err: string) => void) => void
      lookupOnGrow: (cb: (width: number, height: number) => void) => void
      lookupPasteText: (text: string) => void
      lookupPasteImage: (base64: string) => void
      lookupOcrImage: (base64: string) => Promise<{ text: string; error?: string }>
      lookupInputChanged: (hasText: boolean) => void
      lookupClose: () => void
      lookupTriggerGrow: () => void
      lookupReady: () => void
      lookupTransferToChat: (state: ConversationState, conversationId?: string) => void

      /* Chat streaming channels */
      chatSend: (payload: {
        messages: Array<{ role: string; content: string }>
        requestId: string
        role?: string
      }) => void
      chatExpand: (payload: {
        messages: Array<{ role: string; content: string }>
        requestId: string
        role?: string
      }) => void
      chatCancel: (requestId: string) => void
      chatOnChunk: (cb: (data: { requestId: string; text: string }) => void) => () => void
      chatOnResponse: (
        cb: (data: { requestId: string; text: string; cancelled?: boolean }) => void
      ) => () => void
      chatOnError: (cb: (data: { requestId: string; error: string }) => void) => () => void
      chatOnExpandChunk: (
        cb: (data: {
          requestId: string
          text?: string
          error?: string
          done?: boolean
          cancelled?: boolean
        }) => void
      ) => () => void
      chatOnReplaceConversation: (
        cb: (data: {
          state: ConversationState
          conversationId: string
          conversationTitle: string
          conversationCreatedAt: string
        }) => void
      ) => () => void

      /* Conversation persistence */
      saveConversation: (record: ConversationRecord) => Promise<void>
      loadConversation: (id: string) => Promise<ConversationRecord | null>
      deleteConversation: (id: string) => Promise<void>
      listConversations: () => Promise<ConversationMeta[]>
      searchConversations: (query: string) => Promise<ConversationSearchResult[]>
      listUnfedConversations: () => Promise<ConversationMeta[]>
      markConversationKbFed: (id: string) => Promise<void>
      exportConversation: (
        id: string
      ) => Promise<{ ok: true; path: string } | { ok: false; error: string }>

      kbLoadPrompt: () => Promise<{ prompt: string; keywords: CategorizedKeyword[] }>
      kbSavePrompt: (content: string) => Promise<{
        prompt: string
        keywords: CategorizedKeyword[]
      }>
      kbReset: () => Promise<{ prompt: string; keywords: CategorizedKeyword[] }>
      kbAnalyze: () => Promise<{
        newPrompt: string
        keywords: CategorizedKeyword[]
        conversationsAnalyzed: number
      }>
      kbReanalyze: (n: number) => Promise<{
        newPrompt: string
        keywords: CategorizedKeyword[]
        conversationsAnalyzed: number
      }>
      kbGetStatus: () => Promise<KbMaintenanceStatus>
      kbOnStatus: (cb: (status: KbMaintenanceStatus) => void) => () => void
    }
  }
}
