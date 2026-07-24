import { join } from 'path'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { app, ipcMain, globalShortcut } from 'electron'
import { registerGlobalShortcutPortal } from './services/global-shortcut'
import { handleHotkeyPressed } from './lookup/lookup'
import {
  type RoleId,
  type ModelConfig,
  type Connection,
  createDefaultModelConfig
} from './models/registries'

/* ---- Errors ---- */

export class RoleUnassignedError extends Error {
  constructor(roleId: RoleId) {
    const label: Record<RoleId, string> = {
      chat: 'Chat',
      lookup: 'Lookup',
      'kb-maintenance': 'Knowledge Base Maintenance'
    }
    super(
      `No model assigned to the ${label[roleId] ?? roleId} role. Open Settings → Models to configure it.`
    )
    this.name = 'RoleUnassignedError'
  }
}

/* Re-export shared model-config types for main-process callers (provider.ts, handlers.ts). */
export type { Connection, RoleAssignment, ModelConfig } from './models/registries'

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

/* ---- App general settings management -- */

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

/* ---- App model config ---- */

export function loadModelConfig(): ModelConfig {
  try {
    const configPath = join(app.getPath('userData'), 'config', 'providers.json')
    if (!existsSync(configPath)) return createDefaultModelConfig()
    return JSON.parse(readFileSync(configPath, 'utf-8')) as ModelConfig
  } catch {
    return createDefaultModelConfig()
  }
}

export function saveModelConfig(config: ModelConfig): boolean {
  try {
    const configDir = ensureConfigDir()
    writeFileSync(join(configDir, 'providers.json'), JSON.stringify(config, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

export function resolveRole(
  roleId: RoleId
): { connection: Connection; model: string; webSearchEnabled: boolean } | null {
  const config = loadModelConfig()
  const assignment = config.roles[roleId]
  if (!assignment || !assignment.connectionId) return null
  const connection = config.connections[assignment.connectionId]
  if (!connection) return null
  return { connection, model: assignment.model, webSearchEnabled: assignment.webSearchEnabled }
}

/* ---- IPC handlers ---- */

export function registerConfigIpcHandlers(): void {
  // Settings (hotkey)
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

  /* v2 model config IPC */
  ipcMain.handle('load-model-config', (): ModelConfig => {
    return loadModelConfig()
  })

  ipcMain.handle('save-model-config', (_event, config: ModelConfig): { success: boolean } => {
    return { success: saveModelConfig(config) }
  })
}

/* ---- KB prompt persistence ---- */

function kbDir(): string {
  const dir = join(app.getPath('userData'), 'kb')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function loadKbPrompt(): string {
  try {
    const promptPath = join(kbDir(), 'prompt.txt')
    if (!existsSync(promptPath)) return ''
    return readFileSync(promptPath, 'utf-8')
  } catch {
    return ''
  }
}

export function saveKbPrompt(content: string): void {
  const promptPath = join(kbDir(), 'prompt.txt')
  writeFileSync(promptPath, content, 'utf-8')
}
