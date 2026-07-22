import { app, shell, BrowserWindow, ipcMain, globalShortcut, Tray, Menu } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { unregisterGlobalShortcutPortal } from './services/global-shortcut'
import { loadAppSettings, registerHotkey, currentCloseToTray } from './config'
import { handleHotkeyPressed } from './lookup/lookup'
import {
  callProviderStream,
  NoApiKeyError,
  UnsupportedProviderError,
  RoleUnassignedError
} from './provider'
import type { ProviderMessage } from './provider'
import type { RoleId } from '../shared/models'
import {
  lookupSessions,
  animateGrowSession,
  LOOKUP_GROWN_WIDTH,
  LOOKUP_GROWN_HEIGHT
} from './lookup/window'
import { sendToSession } from './lookup/state'
import { setMainWindow, getMainWindow } from './main-window'
import type { ConversationState } from '../shared/conversation'

/* ---- App lifecycle ---- */
app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.deltaai')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  /* Chat streaming: send a message */
  ipcMain.on(
    'chat-send',
    async (event, payload: { messages: ProviderMessage[]; requestId: string; role?: string }) => {
      const { messages, requestId } = payload
      const role: RoleId = (payload.role as RoleId) ?? 'chat'
      try {
        let fullResponse = ''
        for await (const chunk of callProviderStream(messages, role)) {
          fullResponse += chunk
          event.sender.send('chat-chunk', { requestId, text: fullResponse })
        }
        event.sender.send('chat-response', { requestId, text: fullResponse })
      } catch (err) {
        let msg: string
        if (
          err instanceof NoApiKeyError ||
          err instanceof UnsupportedProviderError ||
          err instanceof RoleUnassignedError
        ) {
          msg = err.message
        } else if (err instanceof Error) {
          msg = err.message
        } else {
          msg = String(err)
        }
        event.sender.send('chat-error', { requestId, error: msg })
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
      try {
        let fullResponse = ''
        for await (const chunk of callProviderStream(messages, role)) {
          fullResponse += chunk
          event.sender.send('chat-expand-chunk', { requestId, text: fullResponse })
        }
        event.sender.send('chat-expand-chunk', { requestId, text: fullResponse, done: true })
      } catch (err) {
        let msg: string
        if (
          err instanceof NoApiKeyError ||
          err instanceof UnsupportedProviderError ||
          err instanceof RoleUnassignedError
        ) {
          msg = err.message
        } else if (err instanceof Error) {
          msg = err.message
        } else {
          msg = String(err)
        }
        event.sender.send('chat-expand-chunk', { requestId, error: msg })
      }
    }
  )

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
  ipcMain.on('lookup-transfer', (_event, state: ConversationState) => {
    const session = lookupSessions.find((s) => s.window.webContents.id === _event.sender.id)
    if (session) {
      session.window.close()
    }
    const mainWin = getMainWindow()
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('chat-replace-conversation', state)
      mainWin.show()
      mainWin.focus()
    }
  })

  const settings = loadAppSettings()
  await registerHotkey(settings.hotkey, handleHotkeyPressed)

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', async () => {
  globalShortcut.unregisterAll()
  await unregisterGlobalShortcutPortal()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

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
      devTools: false
    }
  })

  setMainWindow(mainWindow)

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
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  createTray(mainWindow)
}
