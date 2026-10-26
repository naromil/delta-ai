import { join } from 'path'
import { readFileSync, existsSync, mkdirSync } from 'fs'
import { app, ipcMain, globalShortcut } from 'electron'
import { registerGlobalShortcutPortal } from './services/global-shortcut'
import { configureLocalShortcut, setHotkeyCaptureActive } from './services/local-shortcut'
import { handleHotkeyPressed } from './lookup/lookup'
import { writeFileAtomicSync } from './services/atomic-file'
import { isSealedSecret, openSecret, sealSecret } from './services/secret-store'
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
  /** Learn the user's preferences in the background; see `kb/maintenance.ts`. */
  kbAutoMaintain: boolean
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
  const wasRegistered = globalHotkeyRegistered
  const wayland = isWaylandSession()

  // Re-registering the already-active shortcut would either churn the portal or
  // (if the desktop reports failure) arm the in-app fallback on top of a live
  // global binding, firing twice.
  if (wasRegistered && previousHotkey === accelerator) {
    configureLocalShortcut(accelerator, false)
    return true
  }

  let registered: boolean

  try {
    // On Wayland, route through the XDG GlobalShortcuts portal.
    if (wayland) {
      registered = await registerGlobalShortcutPortal(accelerator, () => {
        console.log(`Hotkey ${accelerator} pressed`)
        onPressed()
      })
    } else {
      // Bind the new accelerator before dropping the old one, so a refused or
      // invalid combination cannot leave the app without a working hotkey.
      registered = globalShortcut.register(accelerator, () => {
        console.log(`Hotkey ${accelerator} pressed`)
        onPressed()
      })
      if (
        registered &&
        previousHotkey !== accelerator &&
        globalShortcut.isRegistered(previousHotkey)
      ) {
        globalShortcut.unregister(previousHotkey)
      }
    }
  } catch (err) {
    // Restore the previous binding state and let the caller report the failure.
    currentHotkey = previousHotkey
    globalHotkeyRegistered = wasRegistered
    configureLocalShortcut(previousHotkey, !wasRegistered && previousHotkey !== '')
    throw err
  }

  if (registered) {
    currentHotkey = accelerator
    globalHotkeyRegistered = true
    configureLocalShortcut(accelerator, false)
    return true
  }

  // The desktop refused the new key. On X11 / macOS / Windows the old binding
  // is still live: keep it rather than silently switching to a local-only mode.
  if (
    !wayland &&
    wasRegistered &&
    previousHotkey !== accelerator &&
    globalShortcut.isRegistered(previousHotkey)
  ) {
    currentHotkey = previousHotkey
    globalHotkeyRegistered = true
    configureLocalShortcut(previousHotkey, false)
    return false
  }

  currentHotkey = accelerator
  globalHotkeyRegistered = false
  // Armed only as a fallback: a working global key must never fire twice.
  configureLocalShortcut(accelerator, true)
  console.warn(
    `Global shortcut ${accelerator} unavailable — using the in-app shortcut, ` +
      'which fires while a Delta AI window is focused.'
  )
  return false
}

export function getHotkeyStatus(): HotkeyStatus {
  return {
    accelerator: currentHotkey,
    mode: globalHotkeyRegistered ? 'global' : 'local'
  }
}

export let currentCloseToTray = true
export let currentLookupContextMode: LookupContextMode = 'none'

/* ---- App general settings management -- */

const DEFAULT_SETTINGS: AppSettings = {
  hotkey: DEFAULT_HOTKEY,
  closeToTray: true,
  lookupContextMode: 'none',
  kbAutoMaintain: true
}

/** Accept only the shapes the app can honour; a hand-edited file must not poison them. */
export function normalizeAppSettings(raw: unknown): AppSettings {
  const record =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : ({} as const)
  const hotkey =
    typeof record.hotkey === 'string' && record.hotkey.trim() !== ''
      ? record.hotkey.trim()
      : DEFAULT_SETTINGS.hotkey
  return {
    hotkey,
    closeToTray:
      typeof record.closeToTray === 'boolean' ? record.closeToTray : DEFAULT_SETTINGS.closeToTray,
    lookupContextMode:
      record.lookupContextMode === 'none' ||
      record.lookupContextMode === 'clipboard' ||
      record.lookupContextMode === 'fullscreen-ocr'
        ? record.lookupContextMode
        : DEFAULT_SETTINGS.lookupContextMode,
    kbAutoMaintain:
      typeof record.kbAutoMaintain === 'boolean'
        ? record.kbAutoMaintain
        : DEFAULT_SETTINGS.kbAutoMaintain
  }
}

/**
 * Applies a partial update over the stored settings, so a caller that only
 * knows one field (the Look-Up Guide) cannot reset the others.
 */
export function mergeAppSettings(current: AppSettings, patch: unknown): AppSettings {
  const fields = typeof patch === 'object' && patch !== null && !Array.isArray(patch) ? patch : {}
  return normalizeAppSettings({ ...current, ...fields })
}

export function loadAppSettings(): AppSettings {
  const settingsPath = join(app.getPath('userData'), 'config', 'settings.json')
  try {
    if (!existsSync(settingsPath)) return { ...DEFAULT_SETTINGS }
    return normalizeAppSettings(JSON.parse(readFileSync(settingsPath, 'utf-8')))
  } catch (err) {
    console.warn(`Failed to load app settings from ${settingsPath}:`, err)
    return { ...DEFAULT_SETTINGS }
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
    writeFileAtomicSync(
      join(configDir, 'settings.json'),
      JSON.stringify(normalizeAppSettings(settings), null, 2)
    )
    return true
  } catch {
    return false
  }
}

/* ---- App model config ---- */

function modelConfigPath(): string {
  return join(app.getPath('userData'), 'config', 'providers.json')
}

function mapConnections(
  config: ModelConfig,
  map: (connection: Connection) => Connection
): ModelConfig {
  const connections: Record<string, Connection> = {}
  for (const [id, connection] of Object.entries(config.connections)) {
    connections[id] = map(connection)
  }
  return { ...config, connections }
}

export function saveModelConfig(config: ModelConfig): { ok: boolean; error?: string } {
  const { config: normalized, ok, notes } = migrateModelConfig(config)
  if (!ok) {
    return { ok: false, error: notes.join('; ') || 'invalid model config' }
  }
  const sealed = mapConnections(normalized, (connection) =>
    connection.apiKey ? { ...connection, apiKey: sealSecret(connection.apiKey) } : connection
  )
  try {
    const configDir = ensureConfigDir()
    writeFileAtomicSync(join(configDir, 'providers.json'), JSON.stringify(sealed, null, 2))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Loads `providers.json`, migrating older schema versions and repairing dangling
 * role references, and decrypts the API keys. A repaired file (or one still
 * holding plaintext keys) is written back immediately so the fix sticks.
 */
export function loadModelConfig(): ModelConfig {
  const configPath = modelConfigPath()
  try {
    if (!existsSync(configPath)) return createDefaultModelConfig()
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown
    const { config, changed, notes } = migrateModelConfig(parsed)
    if (notes.length > 0) console.log(`Model config: ${notes.join('; ')}`)

    let hasPlaintextKey = false
    let hasUnreadableKey = false
    const opened = mapConnections(config, (connection) => {
      if (!connection.apiKey) return connection
      if (!isSealedSecret(connection.apiKey)) hasPlaintextKey = true
      const apiKey = openSecret(connection.apiKey)
      if (apiKey !== null) return { ...connection, apiKey }
      hasUnreadableKey = true
      const rest = { ...connection }
      delete rest.apiKey
      return rest
    })

    if (hasUnreadableKey) {
      // The keychain may simply be locked; never write back, or the key is lost.
      console.warn('Model config: an API key could not be decrypted; re-enter it in Settings.')
    } else if (changed || hasPlaintextKey) {
      saveModelConfig(opened)
    }
    return opened
  } catch (err) {
    console.warn(`Failed to load model config from ${configPath}:`, err)
    return createDefaultModelConfig()
  }
}

/** What the renderer may see: whether a key is stored, never the key itself. */
export function redactModelConfig(config: ModelConfig): ModelConfig {
  return mapConnections(config, ({ apiKey, ...connection }) => ({
    ...connection,
    hasApiKey: !!apiKey
  }))
}

/**
 * Fills in the stored key for a connection the renderer sent without one: the
 * renderer only carries a key the user has just typed.
 */
export function withStoredApiKey(connection: Connection, stored: ModelConfig): Connection {
  const rest = { ...connection }
  delete rest.hasApiKey
  if (rest.apiKey !== undefined) return rest
  const apiKey = stored.connections[rest.id]?.apiKey
  return apiKey ? { ...rest, apiKey } : rest
}

export function resolveRole(roleId: RoleId): { connection: Connection; model: string } | null {
  const config = loadModelConfig()
  const assignment = config.roles[roleId]
  if (!assignment || !assignment.connectionId) return null
  const connection = config.connections[assignment.connectionId]
  if (!connection) return null
  return { connection, model: assignment.model }
}

/* ---- Config change notifications ---- */

type AppConfigChangedListener = () => void

const configChangedListeners = new Set<AppConfigChangedListener>()

/**
 * Notifies listeners after a successful settings/model-config save. The
 * Knowledge Base maintenance loop uses it to start learning as soon as it is
 * configured or re-enabled, instead of waiting for the next chat.
 */
export function onAppConfigChanged(listener: AppConfigChangedListener): () => void {
  configChangedListeners.add(listener)
  return () => {
    configChangedListeners.delete(listener)
  }
}

function notifyAppConfigChanged(): void {
  for (const listener of configChangedListeners) {
    try {
      listener()
    } catch (err) {
      console.warn('Config change listener failed:', err)
    }
  }
}

/* ---- IPC handlers ---- */

export function registerConfigIpcHandlers(): void {
  // Settings (hotkey)
  ipcMain.handle(
    'save-settings',
    async (
      _event,
      patch: Partial<AppSettings>
    ): Promise<{ success: boolean; hotkeyMode: 'global' | 'local'; error?: string }> => {
      const previous = loadAppSettings()
      const normalized = mergeAppSettings(previous, patch)

      let registered: boolean
      try {
        registered = await registerHotkey(normalized.hotkey, handleHotkeyPressed)
      } catch (err) {
        // The binding attempt may have thrown (e.g. an invalid accelerator).
        // Put the previous key back and report instead of rejecting the IPC.
        await registerHotkey(previous.hotkey, handleHotkeyPressed).catch(() => undefined)
        return {
          success: false,
          hotkeyMode: getHotkeyStatus().mode,
          error: err instanceof Error ? err.message : 'Failed to register the hotkey.'
        }
      }

      // registerHotkey keeps the previous binding when the new key is refused.
      // Do not persist a shortcut that is not actually active.
      if (!registered && getHotkeyStatus().accelerator !== normalized.hotkey) {
        return {
          success: false,
          hotkeyMode: getHotkeyStatus().mode,
          error:
            `The desktop did not accept "${normalized.hotkey}". ` +
            `The previous shortcut (${previous.hotkey}) is still active.`
        }
      }

      const ok = saveAppSettings(normalized)
      if (ok) {
        applyAppSettings(normalized)
        notifyAppConfigChanged()
      }
      return {
        success: ok,
        hotkeyMode: getHotkeyStatus().mode,
        ...(ok ? {} : { error: 'Failed to save settings.' })
      }
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
    return redactModelConfig(loadModelConfig())
  })

  ipcMain.handle(
    'save-model-config',
    (_event, config: ModelConfig): { success: boolean; error?: string } => {
      if (
        typeof config !== 'object' ||
        config === null ||
        typeof config.connections !== 'object' ||
        config.connections === null
      ) {
        return { success: false, error: 'Invalid model config.' }
      }
      const stored = loadModelConfig()
      const merged = mapConnections(config, (connection) => withStoredApiKey(connection, stored))
      const result = saveModelConfig(merged)
      if (!result.ok) console.warn(`Failed to save model config: ${result.error}`)
      if (result.ok) notifyAppConfigChanged()
      return result.ok ? { success: true } : { success: false, error: result.error }
    }
  )

  /* Provider discovery + connection test (accept the renderer's current, unsaved connection) */
  ipcMain.handle('provider-models', (_event, connection: Connection): Promise<DiscoveredModels> =>
    discoverConnectionModels(withStoredApiKey(connection, loadModelConfig()))
  )

  ipcMain.handle(
    'provider-test',
    (_event, connection: Connection, probeModel?: string): Promise<ConnectionTestResult> =>
      testConnection(withStoredApiKey(connection, loadModelConfig()), probeModel)
  )
}
