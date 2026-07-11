import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  saveConfig: (config: unknown): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('save-config', config),
  loadConfig: (): Promise<unknown> => ipcRenderer.invoke('load-config'),
  sendMessage: (
    messages: Array<{ role: string; content: string }>
  ): Promise<{ success: boolean; response?: string; error?: string }> =>
    ipcRenderer.invoke('send-message', messages),
  loadSettings: (): Promise<{ hotkey: string }> => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings: { hotkey: string }): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('save-settings', settings)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
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
