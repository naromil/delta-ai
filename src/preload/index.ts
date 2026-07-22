import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { ConversationState } from '../shared/conversation'

const api = {
  loadModelConfig: (): Promise<unknown> => ipcRenderer.invoke('load-model-config'),
  saveModelConfig: (config: unknown): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('save-model-config', config),
  loadSettings: (): Promise<{ hotkey: string; closeToTray: boolean }> =>
    ipcRenderer.invoke('load-settings'),
  saveSettings: (settings: {
    hotkey: string
    closeToTray: boolean
  }): Promise<{ success: boolean }> => ipcRenderer.invoke('save-settings', settings),

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
  lookupTransferToChat: (state: ConversationState) => ipcRenderer.send('lookup-transfer', state),

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
  chatOnChunk: (cb: (data: { requestId: string; text: string }) => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      data: { requestId: string; text: string }
    ): void => cb(data)
    ipcRenderer.on('chat-chunk', handler)
    return () => ipcRenderer.removeListener('chat-chunk', handler)
  },
  chatOnResponse: (cb: (data: { requestId: string; text: string }) => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      data: { requestId: string; text: string }
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
    cb: (data: { requestId: string; text?: string; error?: string; done?: boolean }) => void
  ) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      data: { requestId: string; text?: string; error?: string; done?: boolean }
    ): void => cb(data)
    ipcRenderer.on('chat-expand-chunk', handler)
    return () => ipcRenderer.removeListener('chat-expand-chunk', handler)
  },
  chatOnReplaceConversation: (cb: (state: ConversationState) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, state: ConversationState): void => cb(state)
    ipcRenderer.on('chat-replace-conversation', handler)
    return () => ipcRenderer.removeListener('chat-replace-conversation', handler)
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
