import { app, shell, BrowserWindow, ipcMain, globalShortcut } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { unregisterGlobalShortcutPortal } from './globalShortcutPortal'
import { loadProviderConfig, loadAppSettings, registerHotkey } from './config'
import { handleHotkeyPressed } from './lookup'

/* ---- Electron backend: Wayland window decorations ----
 * The lookup feature needs the global cursor position
 * (screen.getCursorScreenPoint()) to know where to OCR and where to pop the
 * overlay. Wayland forbids clients from reading the global pointer — under a
 * native Wayland (ozone) backend that call returns (0,0), and no XDG portal
 * streams *observed* pointer coordinates back to the client
 * (org.freedesktop.portal.RemoteDesktop only *injects* input; its Notify*
 * methods are outbound). On KDE Plasma 6 there is also no KWin D-Bus method
 * that returns the cursor.
 *
 * The only thing that exposes a real cursor on KDE Plasma Wayland today is
 * X11/XQueryPointer, i.e. running Electron under XWayland. That does not
 * reintroduce the recurring desktopCapturer consent prompt on KDE because the
 * capture pipeline routes through org.freedesktop.portal.Screenshot (gated on
 * XDG_SESSION_TYPE, not on the renderer backend), and the global-shortcut path
 * is D-Bus-based and backend-agnostic. So defaulting to XWayland costs us
 * nothing in this codebase.
 *
 * Users who prefer a native Wayland backend (and who do not rely on the lookup
 * feature, or who have wired a portal-cursor source in the future) can opt in
 * with DELTA_AI_WAYLAND=1. */
app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations')

export interface ProviderMessage {
  role: string
  content: string
}

export async function callProvider(messages: ProviderMessage[]): Promise<string> {
  const config = loadProviderConfig()
  if (!config || !config.apiKey) {
    throw new NoApiKeyError('No API key configured. Open Settings to add your provider API key.')
  }

  switch (config.provider) {
    case 'google-ai-studio':
      return await callGoogleAI(config.apiKey, config.model, messages)
    default:
      throw new UnsupportedProviderError(`Provider "${config.provider}" is not supported yet.`)
  }
}

export class NoApiKeyError extends Error {}
export class UnsupportedProviderError extends Error {}

/* ---- Provider dispatch ---- */
async function callGoogleAI(
  apiKey: string,
  model: string,
  messages: ProviderMessage[]
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

/* ---- App lifecycle ---- */
app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.naromil.deltaai')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle(
    'send-message',
    async (
      _event,
      messages: ProviderMessage[]
    ): Promise<{ success: boolean; response?: string; error?: string }> => {
      try {
        const response = await callProvider(messages)
        return { success: true, response }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: msg }
      }
    }
  )

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
