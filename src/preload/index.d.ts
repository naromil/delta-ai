import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      saveConfig: (config: unknown) => Promise<{ success: boolean }>
      saveAllProviders: (config: unknown) => Promise<{ success: boolean }>
      loadConfig: () => Promise<unknown>
      loadAllProviders: () => Promise<unknown>
      sendMessage: (
        messages: Array<{ role: string; content: string }>
      ) => Promise<{ success: boolean; response?: string; error?: string }>
      loadSettings: () => Promise<{ hotkey: string }>
      saveSettings: (settings: { hotkey: string }) => Promise<{ success: boolean }>
      /* Lookup overlay channels (one-way) */
      lookupOnOcr: (cb: (text: string) => void) => void
      lookupOnResponse: (cb: (response: string) => void) => void
      lookupOnError: (cb: (err: string) => void) => void
      /* Lookup ask (renderer → main: send the user's question with OCR context) */
      lookupAsk: (question: string) => void
      /* Lookup grow (main → renderer: animate the window larger to show the conversation) */
      lookupOnGrow: (cb: (width: number, height: number) => void) => void
      lookupClose: () => void
    }
  }
}
