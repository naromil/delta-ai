import { app, shell, BrowserWindow, ipcMain, globalShortcut } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { unregisterGlobalShortcutPortal } from './globalShortcutPortal'
import { loadProviderConfig, loadAppSettings, registerHotkey } from './config'
import { handleHotkeyPressed } from './lookup'

/* ---- Google AI ---- */
export async function callGoogleAI(
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  const contents = messages.map((m) => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content }]
  }))

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents })
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`API error ${res.status}: ${errText}`)
  }

  const data = await res.json()
  const text: string =
    data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text).join('') ??
    '(No response received)'
  return text
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

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
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
}

/* ---- App lifecycle ---- */
app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.naromil.deltaai')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  /* Chat: send message to configured provider */
  ipcMain.handle(
    'send-message',
    async (
      _event,
      messages: Array<{ role: string; content: string }>
    ): Promise<{ success: boolean; response?: string; error?: string }> => {
      const config = loadProviderConfig()
      if (!config || !config.apiKey) {
        return {
          success: false,
          error: 'No API key configured. Open Settings to add your provider API key.'
        }
      }

      try {
        if (config.provider === 'google-ai-studio') {
          const response = await callGoogleAI(config.apiKey, config.model, messages)
          return { success: true, response }
        }
        return { success: false, error: `Provider "${config.provider}" is not supported yet.` }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: msg }
      }
    }
  )

  /* Register hotkey on startup */
  const settings = loadAppSettings()
  await registerHotkey(settings.hotkey, handleHotkeyPressed)

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/* Unregister all shortcuts on quit */
app.on('will-quit', async () => {
  globalShortcut.unregisterAll()
  await unregisterGlobalShortcutPortal()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
