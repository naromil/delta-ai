import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      loadModelConfig: () => Promise<unknown>
      saveModelConfig: (config: unknown) => Promise<{ success: boolean }>
      sendMessage: (
        messages: Array<{ role: string; content: string }>
      ) => Promise<{ success: boolean; response?: string; error?: string }>
      loadSettings: () => Promise<{ hotkey: string; closeToTray: boolean }>
      saveSettings: (settings: {
        hotkey: string
        closeToTray: boolean
      }) => Promise<{ success: boolean }>
      /* Lookup overlay channels (one-way) */
      lookupOnContext: (cb: (state: { status: string; text: string; hint: string }) => void) => void
      lookupOnChunk: (cb: (text: string) => void) => void
      lookupOnResponse: (cb: (response: string) => void) => void
      lookupOnError: (cb: (err: string) => void) => void
      /* Lookup ask (renderer → main: send the user's question with OCR context) */
      lookupAsk: (question: string) => void
      /* Lookup paste (renderer → main: user pasted context, text or image) */
      lookupPasteText: (text: string) => void
      lookupPasteImage: (base64: string) => void
      lookupOcrImage: (base64: string) => Promise<{ text: string; error?: string }>
      /* Lookup input state (renderer → main: whether the Ask field has text) */
      lookupInputChanged: (hasText: boolean) => void
      /* Lookup grow (main → renderer: animate the window larger to show the conversation) */
      lookupOnGrow: (cb: (width: number, height: number) => void) => void
      /* Lookup expand (renderer → main: user asked to expand a word/excerpt in the answer) */
      lookupExpand: (payload: {
        context: string
        question: string
        answer: string
        selection: string
        expansionId: number
      }) => void
      /* Lookup expand-chunk (main → renderer: streaming expansion keyed by expansionId) */
      lookupOnExpandChunk: (
        cb: (chunk: { expansionId: number; text?: string; error?: string }) => void
      ) => void
      lookupClose: () => void
    }
  }
}
