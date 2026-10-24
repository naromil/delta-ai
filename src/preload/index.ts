import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  ConversationState,
  ConversationRecord,
  ConversationSearchResult
} from '../shared/conversation'
import type { CategorizedKeyword, Connection } from '../shared/models'
import type { KbMaintenanceStatus } from '../shared/kb'
import type { ModelCatalogState } from '../shared/model-catalog'
import type { ConnectionTestResult, DiscoveredModels } from '../main/services/model-discovery'

const api = {
  loadModelConfig: (): Promise<unknown> => ipcRenderer.invoke('load-model-config'),
  saveModelConfig: (config: unknown): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('save-model-config', config),
  loadModelCatalog: (force = false): Promise<ModelCatalogState> =>
    ipcRenderer.invoke('load-model-catalog', force),
  listProviderModels: (connection: Connection): Promise<DiscoveredModels> =>
    ipcRenderer.invoke('provider-models', connection),
  testProviderConnection: (
    connection: Connection,
    probeModel?: string
  ): Promise<ConnectionTestResult> => ipcRenderer.invoke('provider-test', connection, probeModel),
  loadSettings: (): Promise<{
    hotkey: string
    closeToTray: boolean
    lookupContextMode: string
    kbAutoMaintain: boolean
  }> => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings: {
    hotkey: string
    closeToTray: boolean
    lookupContextMode: string
    kbAutoMaintain: boolean
  }): Promise<{ success: boolean; hotkeyMode: 'global' | 'local'; error?: string }> =>
    ipcRenderer.invoke('save-settings', settings),
  getHotkeyStatus: (): Promise<{ accelerator: string; mode: 'global' | 'local' }> =>
    ipcRenderer.invoke('hotkey-status'),
  setHotkeyCaptureActive: (active: boolean) => ipcRenderer.send('hotkey-capture-active', active),

  /* Lookup-overlay channels */
  lookupOnContext: (cb: (state: { status: string; text: string; hint: string }) => void) =>
    ipcRenderer.on('lookup-context', (_e, state) => cb(state)),
  lookupOnError: (cb: (err: string) => void) => ipcRenderer.on('ai-error', (_e, err) => cb(err)),
  lookupOnGrow: (cb: (width: number, height: number) => void) =>
    ipcRenderer.on('lookup-grow', (_e, width, height) => cb(width, height)),
  lookupPasteText: (text: string) => ipcRenderer.send('lookup-paste-text', text),
  lookupPasteImage: (base64: string) => ipcRenderer.send('lookup-paste-image', base64),
  lookupOcrImage: (base64: string): Promise<{ text: string; error?: string }> =>
    ipcRenderer.invoke('lookup-ocr-image', base64),
  lookupInputChanged: (hasText: boolean) => ipcRenderer.send('lookup-input-changed', hasText),
  lookupClose: () => ipcRenderer.send('lookup-close'),
  lookupTriggerGrow: () => ipcRenderer.send('lookup-trigger-grow'),
  lookupReady: () => ipcRenderer.send('lookup-ready'),
  lookupTransferToChat: (state: ConversationState, conversationId?: string) =>
    ipcRenderer.send('lookup-transfer', { state, conversationId }),

  /* Chat streaming channels (correlated by requestId) */
  chatSend: (payload: {
    messages: Array<{ role: string; content: string }>
    requestId: string
    role?: string
  }) => ipcRenderer.send('chat-send', payload),
  chatExpand: (payload: {
    messages: Array<{ role: string; content: string }>
    requestId: string
    role?: string
  }) => ipcRenderer.send('chat-expand', payload),
  chatCancel: (requestId: string) => ipcRenderer.send('chat-cancel', requestId),
  chatOnChunk: (cb: (data: { requestId: string; text: string }) => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      data: { requestId: string; text: string }
    ): void => cb(data)
    ipcRenderer.on('chat-chunk', handler)
    return () => ipcRenderer.removeListener('chat-chunk', handler)
  },
  chatOnResponse: (
    cb: (data: { requestId: string; text: string; cancelled?: boolean }) => void
  ) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      data: { requestId: string; text: string; cancelled?: boolean }
    ): void => cb(data)
    ipcRenderer.on('chat-response', handler)
    return () => ipcRenderer.removeListener('chat-response', handler)
  },
  chatOnError: (cb: (data: { requestId: string; error: string }) => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      data: { requestId: string; error: string }
    ): void => cb(data)
    ipcRenderer.on('chat-error', handler)
    return () => ipcRenderer.removeListener('chat-error', handler)
  },
  chatOnExpandChunk: (
    cb: (data: {
      requestId: string
      text?: string
      error?: string
      done?: boolean
      cancelled?: boolean
    }) => void
  ) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      data: {
        requestId: string
        text?: string
        error?: string
        done?: boolean
        cancelled?: boolean
      }
    ): void => cb(data)
    ipcRenderer.on('chat-expand-chunk', handler)
    return () => ipcRenderer.removeListener('chat-expand-chunk', handler)
  },
  chatOnReplaceConversation: (
    cb: (data: {
      state: ConversationState
      conversationId: string
      conversationTitle: string
      conversationCreatedAt: string
    }) => void
  ) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      data: {
        state: ConversationState
        conversationId: string
        conversationTitle: string
        conversationCreatedAt: string
      }
    ): void => cb(data)
    ipcRenderer.on('chat-replace-conversation', handler)
    return () => ipcRenderer.removeListener('chat-replace-conversation', handler)
  },

  /* Conversation persistence */
  saveConversation: (record: ConversationRecord) => ipcRenderer.invoke('conversation-save', record),
  loadConversation: (id: string): Promise<ConversationRecord | null> =>
    ipcRenderer.invoke('conversation-load', id),
  deleteConversation: (id: string): Promise<void> => ipcRenderer.invoke('conversation-delete', id),
  listConversations: () => ipcRenderer.invoke('conversation-list'),
  searchConversations: (query: string): Promise<ConversationSearchResult[]> =>
    ipcRenderer.invoke('conversation-search', query),
  listUnfedConversations: () => ipcRenderer.invoke('conversation-list-unfed'),
  markConversationKbFed: (id: string): Promise<void> =>
    ipcRenderer.invoke('conversation-kb-fed', id),

  kbLoadPrompt: (): Promise<{ prompt: string; keywords: CategorizedKeyword[] }> =>
    ipcRenderer.invoke('kb-load-prompt'),
  kbSavePrompt: (content: string): Promise<{ prompt: string; keywords: CategorizedKeyword[] }> =>
    ipcRenderer.invoke('kb-save-prompt', content),
  kbReset: (): Promise<{ prompt: string; keywords: CategorizedKeyword[] }> =>
    ipcRenderer.invoke('kb-reset'),
  kbAnalyze: (): Promise<{
    newPrompt: string
    keywords: CategorizedKeyword[]
    conversationsAnalyzed: number
  }> => ipcRenderer.invoke('kb-analyze'),
  kbReanalyze: (
    n: number
  ): Promise<{
    newPrompt: string
    keywords: CategorizedKeyword[]
    conversationsAnalyzed: number
  }> => ipcRenderer.invoke('kb-reanalyze', n),
  kbGetStatus: (): Promise<KbMaintenanceStatus> => ipcRenderer.invoke('kb-get-status'),
  kbOnStatus: (cb: (status: KbMaintenanceStatus) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, status: KbMaintenanceStatus): void => cb(status)
    ipcRenderer.on('kb-status', handler)
    return () => ipcRenderer.removeListener('kb-status', handler)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
