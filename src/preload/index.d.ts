import { ElectronAPI } from '@electron-toolkit/preload'
import type { ConversationState } from '../shared/conversation'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      loadModelConfig: () => Promise<unknown>
      saveModelConfig: (config: unknown) => Promise<{ success: boolean }>
      loadSettings: () => Promise<{ hotkey: string; closeToTray: boolean }>
      saveSettings: (settings: {
        hotkey: string
        closeToTray: boolean
      }) => Promise<{ success: boolean }>

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
      lookupTransferToChat: (state: ConversationState) => void

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
      chatOnChunk: (cb: (data: { requestId: string; text: string }) => void) => () => void
      chatOnResponse: (cb: (data: { requestId: string; text: string }) => void) => () => void
      chatOnError: (cb: (data: { requestId: string; error: string }) => void) => () => void
      chatOnExpandChunk: (
        cb: (data: { requestId: string; text?: string; error?: string; done?: boolean }) => void
      ) => () => void
      chatOnReplaceConversation: (cb: (state: ConversationState) => void) => () => void
    }
  }
}
