import { join } from 'path'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { app, ipcMain, globalShortcut } from 'electron'
import { registerGlobalShortcutPortal } from './services/global-shortcut'
import { handleHotkeyPressed } from './lookup/lookup'

/* ---- Types ---- */
interface ProviderConfig {
  apiKey: string
  model: string
  baseUrl?: string
  webSearchEnabled?: boolean
}

interface AllProvidersConfig {
  currentProvider: string
  providers: {
    'google-ai-studio'?: ProviderConfig
    'openai-compatible'?: ProviderConfig
  }
}

interface AppSettings {
  hotkey: string
  closeToTray: boolean
}

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

export function isKdeWaylandSession(): boolean {
  const isKde = !!(process.env['XDG_CURRENT_DESKTOP'] ?? '').match(/\bkde\b/i)
  return isKde && isWaylandSession()
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

export let currentCloseToTray = true

export function loadAppSettings(): AppSettings {
  const defaults: AppSettings = { hotkey: 'Ctrl+Shift+D', closeToTray: true }
  try {
    const settingsPath = join(app.getPath('userData'), 'config', 'settings.json')
    if (existsSync(settingsPath)) {
      const loaded = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      const settings = { ...defaults, ...loaded }
      currentCloseToTray = settings.closeToTray
      return settings
    }
  } catch {
    // ignore
  }
  return defaults
}

function ensureConfigDir(): string {
  const configDir = join(app.getPath('userData'), 'config')
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
  return configDir
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

export function loadProviderConfig(): AllProvidersConfig | null {
  try {
    const configPath = join(app.getPath('userData'), 'config', 'providers.json')
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, 'utf-8')) as AllProvidersConfig
    }
  } catch {
    // ignore
  }
  return null
}

export function loadCurrentProviderConfig(): (ProviderConfig & { provider: string }) | null {
  const allConfig = loadProviderConfig()
  if (!allConfig || !allConfig.currentProvider) return null

  const provider = allConfig.currentProvider
  const providerConfig = allConfig.providers[provider as keyof typeof allConfig.providers]

  if (!providerConfig) return null

  return { provider, ...providerConfig }
}

app.whenReady().then(() => {
  /* Settings (hotkey) */
  ipcMain.handle(
    'save-settings',
    async (_event, settings: AppSettings): Promise<{ success: boolean }> => {
      const ok = saveAppSettings(settings)
      if (ok) {
        currentCloseToTray = settings.closeToTray
        // Re-register hotkey
        await registerHotkey(settings.hotkey, handleHotkeyPressed)
      }
      return { success: ok }
    }
  )

  ipcMain.handle('load-settings', (): AppSettings => {
    return loadAppSettings()
  })

  /* Config save/load (provider) */
  ipcMain.handle(
    'save-config',
    (
      _event,
      config: {
        provider: string
        apiKey: string
        model: string
        baseUrl?: string
        webSearchEnabled?: boolean
      }
    ): { success: boolean } => {
      try {
        const configDir = ensureConfigDir()
        const configPath = join(configDir, 'providers.json')

        // Load existing config or create new structure
        let allConfig: AllProvidersConfig = {
          currentProvider: config.provider,
          providers: {}
        }

        if (existsSync(configPath)) {
          const parsed = JSON.parse(
            readFileSync(configPath, 'utf-8')
          ) as Partial<AllProvidersConfig>
          allConfig = {
            currentProvider: parsed.currentProvider ?? config.provider,
            providers: parsed.providers ?? {}
          }
        }

        // Update the specific provider's config
        allConfig.providers[config.provider as keyof typeof allConfig.providers] = {
          apiKey: config.apiKey,
          model: config.model,
          webSearchEnabled: config.webSearchEnabled ?? false,
          ...(config.baseUrl ? { baseUrl: config.baseUrl } : {})
        }

        // Update current provider
        allConfig.currentProvider = config.provider

        writeFileSync(configPath, JSON.stringify(allConfig, null, 2), 'utf-8')

        return { success: true }
      } catch (error) {
        console.log('Failed to save providers.json: ', error)
        return { success: false }
      }
    }
  )

  ipcMain.handle(
    'save-all-providers',
    (_event, config: AllProvidersConfig): { success: boolean } => {
      try {
        const configDir = ensureConfigDir()
        const configPath = join(configDir, 'providers.json')
        writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
        return { success: true }
      } catch (error) {
        console.log('Failed to save providers.json: ', error)
        return { success: false }
      }
    }
  )

  ipcMain.handle('load-config', (): unknown => {
    try {
      const configPath = join(app.getPath('userData'), 'config', 'providers.json')
      if (existsSync(configPath)) {
        const allConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as AllProvidersConfig
        // Return the current provider's config merged with provider name
        const provider = allConfig.currentProvider
        const providerConfig = allConfig.providers[provider as keyof typeof allConfig.providers]
        if (providerConfig) {
          return { provider, ...providerConfig }
        }
      }
    } catch (error) {
      console.error('Failed to load providers.json: ', error)
      // return null on error
    }
    return null
  })

  ipcMain.handle('load-all-providers', (): unknown => {
    try {
      const configPath = join(app.getPath('userData'), 'config', 'providers.json')
      if (existsSync(configPath)) {
        return JSON.parse(readFileSync(configPath, 'utf-8')) as AllProvidersConfig
      }
    } catch (error) {
      console.warn('Failed to load providers.json: ', error)
      // return null on error
    }
    return null
  })
})
