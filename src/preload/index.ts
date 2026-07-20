import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  saveConfig: (config: unknown): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('save-config', config),
  saveAllProviders: (config: unknown): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('save-all-providers', config),
  loadConfig: (): Promise<unknown> => ipcRenderer.invoke('load-config'),
  loadAllProviders: (): Promise<unknown> => ipcRenderer.invoke('load-all-providers'),
  sendMessage: (
    messages: Array<{ role: string; content: string }>
  ): Promise<{ success: boolean; response?: string; error?: string }> =>
    ipcRenderer.invoke('send-message', messages),
  loadSettings: (): Promise<{ hotkey: string; closeToTray: boolean }> =>
    ipcRenderer.invoke('load-settings'),
  saveSettings: (settings: {
    hotkey: string
    closeToTray: boolean
  }): Promise<{ success: boolean }> => ipcRenderer.invoke('save-settings', settings),

  /* Lookup-overlay channels (one-way, main → overlay page) */
  lookupOnContext: (cb: (state: { status: string; text: string; hint: string }) => void) =>
    ipcRenderer.on('lookup-context', (_e, state) => cb(state)),
  lookupOnChunk: (cb: (text: string) => void) =>
    ipcRenderer.on('lookup-ai-chunk', (_e, text) => cb(text)),
  lookupOnResponse: (cb: (response: string) => void) =>
    ipcRenderer.on('ai-response', (_e, response) => cb(response)),
  lookupOnError: (cb: (err: string) => void) => ipcRenderer.on('ai-error', (_e, err) => cb(err)),
  /* Lookup ask (renderer → main: send the user's question with OCR context) */
  lookupAsk: (question: string) => ipcRenderer.send('lookup-ask', question),
  /* Lookup paste (renderer → main: user pasted context, text or image) */
  lookupPasteText: (text: string) => ipcRenderer.send('lookup-paste-text', text),
  lookupPasteImage: (base64: string) => ipcRenderer.send('lookup-paste-image', base64),
  lookupOcrImage: (base64: string): Promise<{ text: string; error?: string }> =>
    ipcRenderer.invoke('lookup-ocr-image', base64),
  /* Lookup input state (renderer → main: whether the Ask field has text) */
  lookupInputChanged: (hasText: boolean) => ipcRenderer.send('lookup-input-changed', hasText),
  /* Lookup grow (main → renderer: animate the window larger to show the conversation) */
  lookupOnGrow: (cb: (width: number, height: number) => void) =>
    ipcRenderer.on('lookup-grow', (_e, width, height) => cb(width, height)),
  /* Lookup expand (renderer → main: user asked to expand a word/excerpt in the answer) */
  lookupExpand: (payload: {
    context: string
    question: string
    answer: string
    selection: string
    expansionId: number
  }) => ipcRenderer.send('lookup-expand', payload),
  /* Lookup expand-chunk (main → renderer: streaming expansion keyed by expansionId) */
  lookupOnExpandChunk: (
    cb: (chunk: { expansionId: number; text?: string; error?: string }) => void
  ) => ipcRenderer.on('lookup-expand-chunk', (_e, chunk) => cb(chunk)),
  lookupClose: () => ipcRenderer.send('lookup-close')
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
