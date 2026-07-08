import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

interface ProviderConfig {
  provider: string
  apiKey: string
  model: string
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

/** Calls Google AI Studio (Gemini) generateContent endpoint. */
async function callGoogleAI(
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  // Convert chat history to Gemini's "contents" format
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

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      devTools: false // Completely disables DevTools functions and shortcuts
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('io.github.naromil.deltaai')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Config save/load
  ipcMain.handle('save-config', (_event, config: unknown): { success: boolean } => {
    try {
      const configDir = join(app.getPath('userData'), 'config')
      if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
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

  // Chat: send message to configured provider
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

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
