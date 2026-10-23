import { describe, expect, it, vi } from 'vitest'
import { normalizeAppSettings } from '../../src/main/config'

// config.ts pulls in Electron, the portal and the lookup orchestrator. Everything
// under test (settings normalization) is pure, so replace the heavy edges.
vi.mock('electron', () => ({
  app: { getPath: (): string => '/tmp/delta-ai-test' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  globalShortcut: {
    register: vi.fn(() => true),
    unregister: vi.fn(),
    unregisterAll: vi.fn()
  },
  screen: { getDisplayNearestPoint: vi.fn(), getCursorScreenPoint: vi.fn() },
  clipboard: { readText: vi.fn(() => ''), readImage: vi.fn() },
  desktopCapturer: { getSources: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn() }
}))

vi.mock('../../src/main/services/global-shortcut', () => ({
  registerGlobalShortcutPortal: vi.fn(),
  unregisterGlobalShortcutPortal: vi.fn()
}))

vi.mock('../../src/main/lookup/lookup', () => ({
  handleHotkeyPressed: vi.fn()
}))

vi.mock('../../src/main/services/local-shortcut', () => ({
  configureLocalShortcut: vi.fn(),
  setHotkeyCaptureActive: vi.fn()
}))

const DEFAULTS = {
  hotkey: 'Ctrl+Shift+D',
  closeToTray: true,
  lookupContextMode: 'clipboard'
}

describe('normalizeAppSettings', () => {
  it('falls back to defaults for a non-object payload', () => {
    expect(normalizeAppSettings(null)).toEqual(DEFAULTS)
    expect(normalizeAppSettings('nope')).toEqual(DEFAULTS)
    expect(normalizeAppSettings([])).toEqual(DEFAULTS)
  })

  it('keeps a valid lookup context mode and rejects unknown ones', () => {
    expect(normalizeAppSettings({ lookupContextMode: 'fullscreen-ocr' }).lookupContextMode).toBe(
      'fullscreen-ocr'
    )
    expect(normalizeAppSettings({ lookupContextMode: 'clipboard' }).lookupContextMode).toBe(
      'clipboard'
    )
    expect(normalizeAppSettings({ lookupContextMode: 'telepathy' }).lookupContextMode).toBe(
      'clipboard'
    )
    expect(normalizeAppSettings({ lookupContextMode: null }).lookupContextMode).toBe('clipboard')
  })

  it('trims a hotkey and replaces blank or non-string values with the default', () => {
    expect(normalizeAppSettings({ hotkey: '  Ctrl+Space  ' }).hotkey).toBe('Ctrl+Space')
    expect(normalizeAppSettings({ hotkey: '   ' }).hotkey).toBe(DEFAULTS.hotkey)
    expect(normalizeAppSettings({ hotkey: 42 }).hotkey).toBe(DEFAULTS.hotkey)
  })

  it('only accepts a boolean closeToTray, preserving an explicit false', () => {
    expect(normalizeAppSettings({ closeToTray: false }).closeToTray).toBe(false)
    expect(normalizeAppSettings({ closeToTray: 'false' }).closeToTray).toBe(true)
    expect(normalizeAppSettings({ closeToTray: null }).closeToTray).toBe(true)
  })
})
