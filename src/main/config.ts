import { join } from 'path'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { app, ipcMain, globalShortcut } from 'electron'
import { registerGlobalShortcutPortal } from './services/global-shortcut'
import { configureLocalShortcut, setHotkeyCaptureActive } from './services/local-shortcut'
import { handleHotkeyPressed } from './lookup/lookup'
import {
  type RoleId,
  type ModelConfig,
  type Connection,
  type LookupContextMode,
  createDefaultModelConfig
} from './models/registries'
import { migrateModelConfig } from './models/config-schema'
import {
  discoverConnectionModels,
  testConnection,
  type ConnectionTestResult,
  type DiscoveredModels
} from './services/model-discovery'

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
  lookupContextMode: LookupContextMode
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

export const DEFAULT_HOTKEY = 'Ctrl+Shift+D'

/** How the look-up key is currently reachable. */
export interface HotkeyStatus {
  accelerator: string
  /** `global` = bound system-wide; `local` = in-app fallback only. */
  mode: 'global' | 'local'
}

export let currentHotkey = DEFAULT_HOTKEY
let globalHotkeyRegistered = false

/**
 * Binds `accelerator` system-wide. When the desktop refuses the binding (a
 * terminal-launched dev run has no app id for the Wayland portal) the same key
 * is armed as an in-app shortcut instead — see `services/local-shortcut.ts`.
 */
export async function registerHotkey(accelerator: string, onPressed: () => void): Promise<boolean> {
  const previousHotkey = currentHotkey
  currentHotkey = accelerator

  let registered: boolean

  // On Wayland, route through the XDG GlobalShortcuts portal.
  if (isWaylandSession()) {
    registered = await registerGlobalShortcutPortal(accelerator, () => {
      console.log(`Hotkey ${accelerator} pressed`)
      onPressed()
    })
  } else {
    // X11 / macOS / Windows: use Electron's built-in globalShortcut.
    if (previousHotkey && globalShortcut.isRegistered(previousHotkey)) {
      globalShortcut.unregister(previousHotkey)
    }
    registered = globalShortcut.register(accelerator, () => {
      console.log(`Hotkey ${accelerator} pressed`)
      onPressed()
    })
    if (!registered) console.warn(`Failed to register global shortcut: ${accelerator}`)
  }

  globalHotkeyRegistered = registered
  // Armed only as a fallback: a working global key must never fire twice.
  configureLocalShortcut(accelerator, !registered)
  if (!registered) {
    console.warn(
      `Global shortcut ${accelerator} unavailable — using the in-app shortcut, ` +
        'which fires while a Delta AI window is focused.'
    )
  }

  return registered
}

export function getHotkeyStatus(): HotkeyStatus {
  return {
    accelerator: currentHotkey,
    mode: globalHotkeyRegistered ? 'global' : 'local'
  }
}

export let currentCloseToTray = true
export let currentLookupContextMode: LookupContextMode = 'clipboard'

/* ---- App general settings management -- */

export function loadAppSettings(): AppSettings {
  const defaults: AppSettings = {
    hotkey: DEFAULT_HOTKEY,
    closeToTray: true,
    lookupContextMode: 'clipboard'
  }
  const settingsPath = join(app.getPath('userData'), 'config', 'settings.json')
  try {
    if (!existsSync(settingsPath)) return defaults
    const loaded = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Partial<AppSettings>
    return { ...defaults, ...loaded }
  } catch (err) {
    console.warn(`Failed to load app settings from ${settingsPath}:`, err)
    return defaults
  }
}

export function applyAppSettings(settings: AppSettings): void {
  currentCloseToTray = settings.closeToTray
  currentLookupContextMode = settings.lookupContextMode
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

function modelConfigPath(): string {
  return join(app.getPath('userData'), 'config', 'providers.json')
}

export function saveModelConfig(config: ModelConfig): { ok: boolean; error?: string } {
  const { config: normalized, ok, notes } = migrateModelConfig(config)
  if (!ok) {
    return { ok: false, error: notes.join('; ') || 'invalid model config' }
  }
  try {
    const configDir = ensureConfigDir()
    writeFileSync(join(configDir, 'providers.json'), JSON.stringify(normalized, null, 2), 'utf-8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Loads `providers.json`, migrating older schema versions and repairing dangling
 * role references. A repaired file is written back immediately so the fix sticks.
 */
export function loadModelConfig(): ModelConfig {
  const configPath = modelConfigPath()
  try {
    if (!existsSync(configPath)) return createDefaultModelConfig()
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown
    const { config, changed, notes } = migrateModelConfig(parsed)
    if (notes.length > 0) console.log(`Model config: ${notes.join('; ')}`)
    if (changed) saveModelConfig(config)
    return config
  } catch (err) {
    console.warn(`Failed to load model config from ${configPath}:`, err)
    return createDefaultModelConfig()
  }
}

export function resolveRole(roleId: RoleId): { connection: Connection; model: string } | null {
  const config = loadModelConfig()
  const assignment = config.roles[roleId]
  if (!assignment || !assignment.connectionId) return null
  const connection = config.connections[assignment.connectionId]
  if (!connection) return null
  return { connection, model: assignment.model }
}

/* ---- IPC handlers ---- */

export function registerConfigIpcHandlers(): void {
  // Settings (hotkey)
  ipcMain.handle(
    'save-settings',
    async (_event, settings: AppSettings): Promise<{ success: boolean }> => {
      const ok = saveAppSettings(settings)
      if (ok) {
        applyAppSettings(settings)
        // Re-register hotkey
        await registerHotkey(settings.hotkey, handleHotkeyPressed)
      }
      return { success: ok }
    }
  )

  ipcMain.handle('load-settings', (): AppSettings => {
    return loadAppSettings()
  })

  /* Where the look-up key currently works (system-wide or in-app only) */
  ipcMain.handle('hotkey-status', (): HotkeyStatus => getHotkeyStatus())

  /* Suspend the in-app fallback while the hotkey field captures a combination */
  ipcMain.on('hotkey-capture-active', (_event, active: boolean) => {
    setHotkeyCaptureActive(!!active)
  })

  /* v2 model config IPC */
  ipcMain.handle('load-model-config', (): ModelConfig => {
    return loadModelConfig()
  })

  ipcMain.handle(
    'save-model-config',
    (_event, config: ModelConfig): { success: boolean; error?: string } => {
      const result = saveModelConfig(config)
      if (!result.ok) console.warn(`Failed to save model config: ${result.error}`)
      return result.ok ? { success: true } : { success: false, error: result.error }
    }
  )

  /* Provider discovery + connection test (accept the renderer's current, unsaved connection) */
  ipcMain.handle('provider-models', (_event, connection: Connection): Promise<DiscoveredModels> =>
    discoverConnectionModels(connection)
  )

  ipcMain.handle(
    'provider-test',
    (_event, connection: Connection, probeModel?: string): Promise<ConnectionTestResult> =>
      testConnection(connection, probeModel)
  )
}
