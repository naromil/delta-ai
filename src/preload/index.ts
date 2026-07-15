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
  loadSettings: (): Promise<{ hotkey: string }> => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings: { hotkey: string }): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('save-settings', settings),

  /* Lookup-overlay channels (one-way, main → overlay page) */
  lookupOnOcr: (cb: (text: string) => void) => ipcRenderer.on('ocr-result', (_e, text) => cb(text)),
  lookupOnResponse: (cb: (response: string) => void) =>
    ipcRenderer.on('ai-response', (_e, response) => cb(response)),
  lookupOnError: (cb: (err: string) => void) => ipcRenderer.on('ai-error', (_e, err) => cb(err)),
  /* Lookup ask (renderer → main: send the user's question with OCR context) */
  lookupAsk: (question: string) => ipcRenderer.send('lookup-ask', question),
  /* Lookup grow (main → renderer: animate the window larger to show the conversation) */
  lookupOnGrow: (cb: (width: number, height: number) => void) =>
    ipcRenderer.on('lookup-grow', (_e, width, height) => cb(width, height)),
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
