import { join } from 'path'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { app, ipcMain } from 'electron'

/* ---- Types ---- */
export interface ProviderConfig {
  provider: string
  apiKey: string
  model: string
}

export interface AppSettings {
  hotkey: string
}

import { globalShortcut } from 'electron'
import { registerGlobalShortcutPortal } from './globalShortcutPortal'
import { handleHotkeyPressed } from './lookup'

/* ---- Wayland detection ----
 * On a native Wayland session (KDE Plasma, GNOME) Electron's `globalShortcut`
 * cannot bind keys via X11/XTest, so we route through the XDG Desktop Portal
 * GlobalShortcuts backend instead (see globalShortcutPortal.ts).
 */
export function isWaylandSession(): boolean {
  return (
    process.env['XDG_SESSION_TYPE'] === 'wayland' ||
    !!process.env['WAYLAND_DISPLAY'] ||
    process.env['ELECTRON_OZONE_PLATFORM_HINT'] === 'wayland'
  )
}

/* ---- Global shortcut management ---- */
export let currentHotkey = 'Ctrl+Shift+D'

export async function registerHotkey(accelerator: string, onPressed: () => void): Promise<boolean> {
  currentHotkey = accelerator

  // On Wayland, route through the XDG GlobalShortcuts portal.
  if (isWaylandSession()) {
    return await registerGlobalShortcutPortal(accelerator, () => {
      console.log(`Hotkey ${accelerator} pressed`)
      onPressed()
    })
  }

  // X11 / macOS / Windows: use Electron's built-in globalShortcut.
  if (currentHotkey && globalShortcut.isRegistered(currentHotkey)) {
    globalShortcut.unregister(currentHotkey)
  }
  const success = globalShortcut.register(accelerator, () => {
    console.log(`Hotkey ${accelerator} pressed`)
    onPressed()
  })

  if (!success) {
    console.warn(`Failed to register global shortcut: ${accelerator}`)
  }

  return success
}
export function ensureConfigDir(): string {
  const configDir = join(app.getPath('userData'), 'config')
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
  return configDir
}

export function loadProviderConfig(): ProviderConfig | null {
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

export function loadAppSettings(): AppSettings {
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

export function saveAppSettings(settings: AppSettings): boolean {
  try {
    const configDir = ensureConfigDir()
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

app.whenReady().then(() => {
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
        await registerHotkey(settings.hotkey, handleHotkeyPressed)
      }
      return { success: ok }
    }
  )
})
