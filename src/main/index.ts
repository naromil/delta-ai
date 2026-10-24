import { app, shell, BrowserWindow, ipcMain, globalShortcut, Tray, Menu } from 'electron'
import type { WebContents } from 'electron'
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
import { setMainWindow, getMainWindow, clearMainWindow } from './main-window'
import { applyContextBudget } from './context-budget'
import { exportConversationToFile } from './conversation-export'
import type { ConversationRecord, ConversationState } from '../shared/conversation'
import { buildConversationTitle } from '../shared/conversation'
import { prepareTransferredState } from './transfer'
import {
  saveConversation,
  loadConversation,
  deleteConversation,
  listConversations,
  markConversationKbFed,
  listUnfedConversations,
  searchConversations
} from './conversations'
import { registerKbIpcHandlers } from './kb/handlers'
import { startKbAutoMaintenance, stopKbAutoMaintenance } from './kb/maintenance'
import { registerModelCatalogIpcHandlers } from './services/model-catalog'
import { loadKbPrompt } from './kb/store'

interface ActiveStream {
  controller: AbortController
  /** The webContents that started the request; only it may cancel it. */
  senderId: number
}

/** In-flight provider streams, keyed by requestId, so the UI can stop them. */
const activeStreams = new Map<string, ActiveStream>()

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
        // Chat sends are trimmed after any KB prompt insertion; lookup keeps its
        // full screen context.
        const finalMessages = role === 'chat' ? applyContextBudget(messages, role) : messages
        const sender = event.sender
        const controller = new AbortController()
        // A closed popup must stop the request instead of throwing on every send.
        const onDestroyed = (): void => controller.abort()
        sender.once('destroyed', onDestroyed)
        activeStreams.set(requestId, { controller, senderId: sender.id })
        let fullResponse = ''
        try {
          for await (const chunk of callProviderStream(finalMessages, role, controller.signal)) {
            fullResponse += chunk
            safeSend(sender, 'chat-chunk', { requestId, text: fullResponse })
          }
          safeSend(sender, 'chat-response', { requestId, text: fullResponse })
        } catch (err) {
          if (controller.signal.aborted) {
            safeSend(sender, 'chat-response', { requestId, text: fullResponse, cancelled: true })
          } else {
            safeSend(sender, 'chat-error', { requestId, error: formatStreamError(err) })
          }
        } finally {
          sender.removeListener('destroyed', onDestroyed)
          if (activeStreams.get(requestId)?.controller === controller) {
            activeStreams.delete(requestId)
          }
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
        const sender = event.sender
        const controller = new AbortController()
        const onDestroyed = (): void => controller.abort()
        sender.once('destroyed', onDestroyed)
        activeStreams.set(requestId, { controller, senderId: sender.id })
        let fullResponse = ''
        try {
          for await (const chunk of callProviderStream(messages, role, controller.signal)) {
            fullResponse += chunk
            safeSend(sender, 'chat-expand-chunk', { requestId, text: fullResponse })
          }
          safeSend(sender, 'chat-expand-chunk', { requestId, text: fullResponse, done: true })
        } catch (err) {
          safeSend(
            sender,
            'chat-expand-chunk',
            controller.signal.aborted
              ? { requestId, text: fullResponse, done: true, cancelled: true }
              : { requestId, error: formatStreamError(err) }
          )
        } finally {
          sender.removeListener('destroyed', onDestroyed)
          if (activeStreams.get(requestId)?.controller === controller) {
            activeStreams.delete(requestId)
          }
        }
      }
    )

    /** Stop a provider stream started by chat-send/chat-expand. */
    ipcMain.on('chat-cancel', (event, requestId: string) => {
      const stream = activeStreams.get(requestId)
      // Only the window that started the request may stop it.
      if (stream && stream.senderId === event.sender.id) stream.controller.abort()
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
      async (event, payload: { state: ConversationState; conversationId?: string }) => {
        const { state, conversationId } = payload
        const session = lookupSessions.find((s) => s.window.webContents.id === event.sender.id)

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

        // Persist before closing anything: a failed write leaves the popup open
        // with its error shown, so the user can retry instead of losing the chat.
        try {
          await saveConversation(record)
        } catch (err) {
          if (session) sendToSession(session, 'ai-error', formatStreamError(err))
          return
        }

        if (session && !session.window.isDestroyed()) session.window.close()

        deliverConversation({
          state: transferred,
          conversationId: id,
          conversationTitle: title,
          conversationCreatedAt: createdAt
        })
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
    ipcMain.handle('conversation-list-unfed', async () => {
      return await listUnfedConversations()
    })
    ipcMain.handle('conversation-kb-fed', async (_event, id: string) => {
      await markConversationKbFed(id)
    })
    ipcMain.handle('conversation-export', async (_event, id: unknown) => {
      if (typeof id !== 'string' || id.length === 0) {
        return { ok: false, error: 'Invalid conversation id.' }
      }
      return await exportConversationToFile(id)
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
    startKbAutoMaintenance()

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('will-quit', async () => {
  stopKbAutoMaintenance()
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

/** Sends only while the renderer is alive; a closed popup must not throw mid-stream. */
function safeSend(sender: WebContents, channel: string, payload: unknown): void {
  if (sender.isDestroyed()) return
  sender.send(channel, payload)
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

function createTray(): void {
  if (tray) return
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
      click: () => showMainWindow()
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

  tray.on('click', () => showMainWindow())
}

/** Brings the current chat window forward, recreating it after a real close. */
function showMainWindow(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    // `createWindow`'s ready-to-show handler performs the show/focus.
    createWindow()
    return
  }
  win.show()
  win.focus()
}

/* ---- Main window ---- */
function createWindow(): BrowserWindow {
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

  // A hidden-to-tray window still exists; a closed one must not be handed out.
  mainWindow.on('closed', () => {
    clearMainWindow()
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

  createTray()

  return mainWindow
}

interface ConversationDelivery {
  state: ConversationState
  conversationId: string
  conversationTitle: string
  conversationCreatedAt: string
}

/**
 * Hydrates the transferred conversation into the chat window. Without one, a
 * fresh window is created and receives the payload once its renderer loads.
 */
function deliverConversation(payload: ConversationDelivery): void {
  const existing = getMainWindow()
  if (existing && !existing.isDestroyed()) {
    showMainWindow()
    safeSend(existing.webContents, 'chat-replace-conversation', payload)
    return
  }

  const win = createWindow()
  const deliver = (): void => {
    if (!win.isDestroyed()) safeSend(win.webContents, 'chat-replace-conversation', payload)
  }
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', deliver)
  } else {
    deliver()
  }
}

function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const { protocol } = new URL(rawUrl)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
