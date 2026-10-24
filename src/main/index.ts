import { app, shell, BrowserWindow, ipcMain, globalShortcut, Tray, Menu } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { unregisterGlobalShortcutPortal } from './services/global-shortcut'
import { installLocalShortcut } from './services/local-shortcut'
import {
  loadAppSettings,
  applyAppSettings,
  registerHotkey,
  currentCloseToTray,
  registerConfigIpcHandlers,
  DEFAULT_HOTKEY
} from './config'
import { handleHotkeyPressed } from './lookup/lookup'
import { callProviderStream } from './provider'
import type { ProviderMessage } from './provider'
import type { RoleId } from '../shared/models'
import {
  lookupSessions,
  animateGrowSession,
  registerLookupIpcHandlers,
  LOOKUP_GROWN_WIDTH,
  LOOKUP_GROWN_HEIGHT
} from './lookup/window'
import { sendToSession } from './lookup/state'
import { setMainWindow, getMainWindow } from './main-window'
import type { ConversationRecord, ConversationState } from '../shared/conversation'
import { buildConversationTitle } from '../shared/conversation'
import { prepareTransferredState } from './transfer'
import {
  saveConversation,
  loadConversation,
  deleteConversation,
  listConversations,
  loadMostRecentChat,
  markConversationKbFed,
  listUnfedConversations,
  searchConversations
} from './conversations'
import { registerKbIpcHandlers } from './kb/handlers'
import { registerModelCatalogIpcHandlers } from './services/model-catalog'
import { loadKbPrompt } from './kb/store'

/** In-flight provider streams, keyed by requestId, so the UI can stop them. */
const activeStreams = new Map<string, AbortController>()

/* ---- App lifecycle ---- */
const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      return
    }
    createWindow()
  })

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.deltaai')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    /* Chat streaming: send a message */
    ipcMain.on(
      'chat-send',
      async (event, payload: { messages: ProviderMessage[]; requestId: string; role?: string }) => {
        const { requestId } = payload
        const role: RoleId = (payload.role as RoleId) ?? 'chat'
        const messages =
          role === 'lookup' ? withKbPrompt(payload.messages, loadKbPrompt()) : payload.messages
        const controller = new AbortController()
        activeStreams.set(requestId, controller)
        let fullResponse = ''
        try {
          for await (const chunk of callProviderStream(messages, role, controller.signal)) {
            fullResponse += chunk
            event.sender.send('chat-chunk', { requestId, text: fullResponse })
          }
          event.sender.send('chat-response', { requestId, text: fullResponse })
        } catch (err) {
          if (controller.signal.aborted) {
            event.sender.send('chat-response', { requestId, text: fullResponse, cancelled: true })
          } else {
            event.sender.send('chat-error', { requestId, error: formatStreamError(err) })
          }
        } finally {
          activeStreams.delete(requestId)
        }
      }
    )

    /* Chat streaming: expand a word/excerpt */
    ipcMain.on(
      'chat-expand',
      async (
        event,
        payload: {
          messages: ProviderMessage[]
          requestId: string
          role?: string
        }
      ) => {
        const { messages, requestId } = payload
        const role: RoleId = (payload.role as RoleId) ?? 'chat'
        const controller = new AbortController()
        activeStreams.set(requestId, controller)
        let fullResponse = ''
        try {
          for await (const chunk of callProviderStream(messages, role, controller.signal)) {
            fullResponse += chunk
            event.sender.send('chat-expand-chunk', { requestId, text: fullResponse })
          }
          event.sender.send('chat-expand-chunk', { requestId, text: fullResponse, done: true })
        } catch (err) {
          event.sender.send(
            'chat-expand-chunk',
            controller.signal.aborted
              ? { requestId, text: fullResponse, done: true, cancelled: true }
              : { requestId, error: formatStreamError(err) }
          )
        } finally {
          activeStreams.delete(requestId)
        }
      }
    )

    /** Stop a provider stream started by chat-send/chat-expand. */
    ipcMain.on('chat-cancel', (_event, requestId: string) => {
      activeStreams.get(requestId)?.abort()
    })

    /* Lookup: trigger window grow on first ask */
    ipcMain.on('lookup-trigger-grow', (event) => {
      const session = lookupSessions.find((s) => s.window.webContents.id === event.sender.id)
      if (session && !session.grown) {
        sendToSession(session, 'lookup-grow', LOOKUP_GROWN_WIDTH, LOOKUP_GROWN_HEIGHT)
        animateGrowSession(session, LOOKUP_GROWN_WIDTH, LOOKUP_GROWN_HEIGHT)
        session.grown = true
      }
    })

    /* Lookup: transfer conversation to chat window */
    ipcMain.on(
      'lookup-transfer',
      async (_event, payload: { state: ConversationState; conversationId?: string }) => {
        const { state, conversationId } = payload
        const session = lookupSessions.find((s) => s.window.webContents.id === _event.sender.id)
        if (session) {
          session.window.close()
        }

        // Single boundary: finalise in-flight frames before persisting or
        // forwarding, and fold the screen context into a user turn.
        const transferred = prepareTransferredState(state)

        const now = new Date().toISOString()
        const existing = conversationId ? await loadConversation(conversationId) : null
        const id = existing?.id ?? conversationId ?? crypto.randomUUID()
        const createdAt = existing?.createdAt ?? now
        const firstUserTurn = transferred.turns.find((turn) => turn.role === 'user')
        const title = existing?.title || buildConversationTitle(firstUserTurn?.content ?? '')
        const record: ConversationRecord = {
          ...(existing ?? {}),
          id,
          title,
          createdAt,
          updatedAt: now,
          source: 'chat',
          state: transferred,
          kbFed: existing?.kbFed ?? false
        }
        await saveConversation(record)

        const mainWin = getMainWindow()
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.webContents.send('chat-replace-conversation', {
            state: transferred,
            conversationId: id,
            conversationTitle: title,
            conversationCreatedAt: createdAt
          })
          mainWin.show()
          mainWin.focus()
        }
      }
    )

    /* Conversation persistence */
    ipcMain.handle('conversation-save', async (_event, record) => {
      // Renderer autosaves must not clobber the KB-fed flag owned by main.
      await saveConversation(record, { preserveKbFed: true })
    })
    ipcMain.handle('conversation-load', async (_event, id: string) => {
      return await loadConversation(id)
    })
    ipcMain.handle('conversation-delete', async (_event, id: string) => {
      await deleteConversation(id)
    })
    ipcMain.handle('conversation-list', async () => {
      return await listConversations('chat')
    })
    ipcMain.handle('conversation-search', async (_event, query: string) => {
      return await searchConversations(typeof query === 'string' ? query : '')
    })
    ipcMain.handle('conversation-load-most-recent', async () => {
      return await loadMostRecentChat()
    })
    ipcMain.handle('conversation-list-unfed', async () => {
      return await listUnfedConversations()
    })
    ipcMain.handle('conversation-kb-fed', async (_event, id: string) => {
      await markConversationKbFed(id)
    })

    registerConfigIpcHandlers() // includes provider-models and provider-test
    registerLookupIpcHandlers()
    registerKbIpcHandlers()
    registerModelCatalogIpcHandlers()

    const settings = loadAppSettings()
    applyAppSettings(settings)
    try {
      await registerHotkey(settings.hotkey, handleHotkeyPressed)
    } catch (err) {
      // A corrupt/hand-edited hotkey must never prevent the window from opening.
      console.warn(
        `Failed to register hotkey "${settings.hotkey}"; falling back to ${DEFAULT_HOTKEY}:`,
        err
      )
      try {
        await registerHotkey(DEFAULT_HOTKEY, handleHotkeyPressed)
      } catch (fallbackErr) {
        console.warn('Failed to register the fallback hotkey:', fallbackErr)
      }
    }

    createWindow()

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('will-quit', async () => {
  globalShortcut.unregisterAll()
  await unregisterGlobalShortcutPortal()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

/* ---- Helpers ---- */

function formatStreamError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function withKbPrompt(messages: ProviderMessage[], kbPrompt: string): ProviderMessage[] {
  if (!kbPrompt) return messages
  const systemIndex = messages.findIndex((msg) => msg.role === 'system')
  if (systemIndex === -1) return [{ role: 'system', content: kbPrompt }, ...messages]
  return messages.map((msg, index) =>
    index === systemIndex ? { ...msg, content: msg.content + '\n\n' + kbPrompt } : msg
  )
}

/* ---- Tray ---- */
let tray: Tray | null = null
let isQuitting = false

app.on('before-quit', () => {
  isQuitting = true
})

function createTray(mainWindow: BrowserWindow): void {
  tray = new Tray(icon)
  tray.setToolTip('Delta AI')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'New Look-up',
      click: () => {
        void handleHotkeyPressed().catch((err) => console.warn('Look-up failed:', err))
      }
    },
    {
      label: 'Show Delta AI',
      click: () => {
        mainWindow.show()
        mainWindow.focus()
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)

  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.focus()
    } else {
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

/* ---- Main window ---- */
function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 960,
    height: 640,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      devTools: is.dev
    }
  })

  setMainWindow(mainWindow)

  // In-app fallback for the look-up key: fires while this window has focus,
  // which is the only thing a terminal-launched dev run can offer.
  installLocalShortcut(mainWindow, handleHotkeyPressed)

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('close', (event) => {
    if (currentCloseToTray && !isQuitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Never let renderer content navigate the app shell away from the bundle.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === mainWindow.webContents.getURL()) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  createTray(mainWindow)
}

function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const { protocol } = new URL(rawUrl)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
