import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  screen,
  desktopCapturer
} from 'electron'
import { join } from 'path'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  registerGlobalShortcutPortal,
  unregisterGlobalShortcutPortal
} from './globalShortcutPortal'

/* ---- Types ---- */
interface ProviderConfig {
  provider: string
  apiKey: string
  model: string
}

interface AppSettings {
  hotkey: string
}

/* ---- Wayland detection ----
 * On a native Wayland session (KDE Plasma, GNOME) Electron's `globalShortcut`
 * cannot bind keys via X11/XTest, so we route through the XDG Desktop Portal
 * GlobalShortcuts backend instead (see globalShortcutPortal.ts).
 */
function isWaylandSession(): boolean {
  return (
    process.env['XDG_SESSION_TYPE'] === 'wayland' ||
    !!process.env['WAYLAND_DISPLAY'] ||
    process.env['ELECTRON_OZONE_PLATFORM_HINT'] === 'wayland'
  )
}

/* ---- Config helpers ---- */
function ensureConfigDir(): string {
  const configDir = join(app.getPath('userData'), 'config')
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
  return configDir
}

function loadProviderConfig(): ProviderConfig | null {
  try {
    const configPath = join(app.getPath('userData'), 'config', 'providers.json')
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, 'utf-8')) as ProviderConfig
    }
  } catch {
    // ignore
  }
  return null
}

function loadAppSettings(): AppSettings {
  const defaults: AppSettings = { hotkey: 'Ctrl+Shift+D' }
  try {
    const settingsPath = join(app.getPath('userData'), 'config', 'settings.json')
    if (existsSync(settingsPath)) {
      const loaded = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      return { ...defaults, ...loaded }
    }
  } catch {
    // ignore
  }
  return defaults
}

function saveAppSettings(settings: AppSettings): boolean {
  try {
    const configDir = ensureConfigDir()
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

/* ---- Google AI ---- */
async function callGoogleAI(
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

/* ---- OCR ---- */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tesseractWorker: any = null

async function runOCR(imageBuffer: Buffer): Promise<string> {
  // Dynamically import tesseract.js (WASM-based, works in main process with sandbox:false)
  const Tesseract = await import('tesseract.js')

  if (!tesseractWorker) {
    tesseractWorker = await Tesseract.createWorker('eng', 1, {
      // Cache language data in userData so it persists
      cachePath: join(app.getPath('userData'), 'tesseract-cache'),
      logger: () => {} // suppress progress logs
    })
  }

  const result = await tesseractWorker.recognize(imageBuffer)
  return result.data.text.trim()
}

/* ---- Screen capture around cursor ---- */
async function captureRegionAroundCursor(width = 400, height = 150): Promise<Buffer | null> {
  const cursorPos = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursorPos)

  // Get all sources (screens)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: display.size.width, height: display.size.height }
  })

  // Find the source matching this display
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!source) return null

  const thumb = source.thumbnail
  if (thumb.isEmpty()) return null

  // Calculate crop region centered on cursor (relative to this display)
  const scaleFactor = display.scaleFactor || 1
  const relX = cursorPos.x - display.bounds.x
  const relY = cursorPos.y - display.bounds.y

  const cropX = Math.max(0, Math.round(relX * scaleFactor - width / 2))
  const cropY = Math.max(0, Math.round(relY * scaleFactor - height / 2))
  const cropW = Math.min(width, display.size.width * scaleFactor - cropX)
  const cropH = Math.min(height, display.size.height * scaleFactor - cropY)

  // Crop the thumbnail
  const cropped = thumb.crop({
    x: cropX,
    y: cropY,
    width: cropW,
    height: cropH
  })

  if (cropped.isEmpty()) return null
  return cropped.toPNG()
}

/* ---- Popup window ---- */
let popupWindow: BrowserWindow | null = null

function createPopupWindow(x: number, y: number): BrowserWindow {
  const window = new BrowserWindow({
    width: 420,
    height: 320,
    x: Math.min(x, screen.getPrimaryDisplay().size.width - 430),
    y: Math.min(y, screen.getPrimaryDisplay().size.height - 340),
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    transparent: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true
    }
  })

  // Auto-close on focus loss
  window.on('blur', () => {
    window.close()
  })

  window.on('closed', () => {
    popupWindow = null
  })

  window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(popupHTML))
  window.once('ready-to-show', () => {
    window.show()
  })

  return window
}

const popupHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background: #1a1a1a;
    color: #e0e0e0;
    padding: 0;
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    user-select: text;
  }
  .header {
    background: #2a2a2a;
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 600;
    color: #aaa;
    border-bottom: 1px solid #333;
    display: flex;
    justify-content: space-between;
    align-items: center;
    -webkit-app-region: drag;
  }
  .header .close {
    -webkit-app-region: no-drag;
    cursor: pointer;
    color: #888;
    font-size: 18px;
    line-height: 1;
  }
  .header .close:hover { color: #fff; }
  .content {
    flex: 1;
    overflow-y: auto;
    padding: 12px 14px;
  }
  .section-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #666;
    margin-bottom: 4px;
    font-weight: 600;
  }
  .extracted {
    font-size: 13px;
    color: #ccc;
    background: #222;
    border-radius: 6px;
    padding: 8px 10px;
    margin-bottom: 12px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 80px;
    overflow-y: auto;
  }
  .ai-response {
    font-size: 14px;
    line-height: 1.5;
    color: #e0e0e0;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .loading {
    color: #666;
    font-style: italic;
  }
  .error {
    color: #ff6b6b;
  }
  .scroll::-webkit-scrollbar { width: 6px; }
  .scroll::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
</style>
</head>
<body>
  <div class="header">
    <span>Delta AI</span>
    <span class="close" onclick="window.close()">✕</span>
  </div>
  <div class="content">
    <div class="section-label">Extracted Text</div>
    <div id="extracted" class="extracted scroll">Waiting for OCR…</div>
    <div class="section-label">AI Response</div>
    <div id="response" class="ai-response scroll"><span class="loading">Waiting for response…</span></div>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    ipcRenderer.on('ocr-result', (_e, text) => {
      const el = document.getElementById('extracted');
      el.textContent = text || '(No text extracted)';
    });
    ipcRenderer.on('ai-response', (_e, response) => {
      const el = document.getElementById('response');
      el.innerHTML = '';
      el.textContent = response;
    });
    ipcRenderer.on('ai-error', (_e, err) => {
      const el = document.getElementById('response');
      el.innerHTML = '';
      el.className = 'ai-response error';
      el.textContent = err;
    });
  </script>
</body>
</html>`

/* ---- Hotkey handler: capture -> OCR -> AI -> popup ---- */
async function handleHotkeyPressed(): Promise<void> {
  const cursorPos = screen.getCursorScreenPoint()

  // Create popup immediately for responsive feel
  if (!popupWindow || popupWindow.isDestroyed()) {
    popupWindow = createPopupWindow(cursorPos.x + 10, cursorPos.y + 10)
  }

  // 1. Capture region around cursor
  const imageBuffer = await captureRegionAroundCursor()
  if (!imageBuffer) {
    popupWindow?.webContents.send('ai-error', 'Failed to capture screen region.')
    return
  }

  // 2. OCR
  let ocrText = ''
  try {
    ocrText = await runOCR(imageBuffer)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    popupWindow?.webContents.send('ai-error', `OCR error: ${msg}`)
    return
  }

  popupWindow?.webContents.send('ocr-result', ocrText)

  if (!ocrText) {
    popupWindow?.webContents.send('ai-error', 'No text detected near cursor.')
    return
  }

  // 3. AI query with extracted text
  const config = loadProviderConfig()
  if (!config || !config.apiKey) {
    popupWindow?.webContents.send(
      'ai-error',
      'No API key configured. Open Settings to add your provider API key.'
    )
    return
  }

  try {
    if (config.provider === 'google-ai-studio') {
      const prompt = `The following text was extracted via OCR from the screen near the user's cursor. Please analyze and respond to it:\n\n"${ocrText}"`
      const response = await callGoogleAI(config.apiKey, config.model, [
        { role: 'user', content: prompt }
      ])
      popupWindow?.webContents.send('ai-response', response)
    } else {
      popupWindow?.webContents.send(
        'ai-error',
        `Provider "${config.provider}" is not supported yet.`
      )
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    popupWindow?.webContents.send('ai-error', msg)
  }
}

/* ---- Global shortcut management ---- */
let currentHotkey = 'Ctrl+Shift+D'

async function registerHotkey(accelerator: string): Promise<boolean> {
  currentHotkey = accelerator

  // On Wayland, route through the XDG GlobalShortcuts portal.
  if (isWaylandSession()) {
    return await registerGlobalShortcutPortal(accelerator, () => {
      console.log(`Hotkey ${accelerator} pressed`)
      handleHotkeyPressed()
    })
  }

  // X11 / macOS / Windows: use Electron's built-in globalShortcut.
  if (currentHotkey && globalShortcut.isRegistered(currentHotkey)) {
    globalShortcut.unregister(currentHotkey)
  }
  const success = globalShortcut.register(accelerator, () => {
    console.log(`Hotkey ${accelerator} pressed`)
    handleHotkeyPressed()
  })

  if (!success) {
    console.warn(`Failed to register global shortcut: ${accelerator}`)
  }

  return success
}

/* ---- Main window ---- */
function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
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
  electronApp.setAppUserModelId('io.github.naromil.deltaai')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  /* Config save/load (provider) */
  ipcMain.handle('save-config', (_event, config: unknown): { success: boolean } => {
    try {
      const configDir = ensureConfigDir()
      const configPath = join(configDir, 'providers.json')
      writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
      return { success: true }
    } catch {
      return { success: false }
    }
  })

  ipcMain.handle('load-config', (): unknown => {
    try {
      const configPath = join(app.getPath('userData'), 'config', 'providers.json')
      if (existsSync(configPath)) {
        return JSON.parse(readFileSync(configPath, 'utf-8'))
      }
    } catch {
      // return null on error
    }
    return null
  })

  /* Settings (hotkey) */
  ipcMain.handle('load-settings', (): AppSettings => {
    return loadAppSettings()
  })

  ipcMain.handle(
    'save-settings',
    async (_event, settings: AppSettings): Promise<{ success: boolean }> => {
      const ok = saveAppSettings(settings)
      if (ok) {
        // Re-register hotkey
        await registerHotkey(settings.hotkey)
      }
      return { success: ok }
    }
  )

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
  await registerHotkey(settings.hotkey)

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
