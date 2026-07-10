import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      saveConfig: (config: unknown) => Promise<{ success: boolean }>
      loadConfig: () => Promise<unknown>
      sendMessage: (
        messages: Array<{ role: string; content: string }>
      ) => Promise<{ success: boolean; response?: string; error?: string }>
      loadSettings: () => Promise<{ hotkey: string }>
      saveSettings: (settings: { hotkey: string }) => Promise<{ success: boolean }>
    }
  }
}
