import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultModelConfig } from '../../src/shared/models'
import type { ModelConfig } from '../../src/shared/models'

const h = vi.hoisted(() => ({ userData: '', encryptionAvailable: true, decryptFails: false }))

// A reversible stand-in for the OS keychain.
vi.mock('electron', () => ({
  app: { getPath: (): string => h.userData },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn(), unregisterAll: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: (): boolean => h.encryptionAvailable,
    encryptString: (plain: string): Buffer => Buffer.from(`sealed(${plain})`),
    decryptString: (data: Buffer): string => {
      if (h.decryptFails) throw new Error('keychain locked')
      return data.toString().replace(/^sealed\((.*)\)$/, '$1')
    }
  }
}))
vi.mock('../../src/main/services/global-shortcut', () => ({
  registerGlobalShortcutPortal: vi.fn(),
  unregisterGlobalShortcutPortal: vi.fn()
}))
vi.mock('../../src/main/lookup/lookup', () => ({ handleHotkeyPressed: vi.fn() }))
vi.mock('../../src/main/services/local-shortcut', () => ({
  configureLocalShortcut: vi.fn(),
  setHotkeyCaptureActive: vi.fn()
}))

import {
  loadModelConfig,
  redactModelConfig,
  saveModelConfig,
  withStoredApiKey
} from '../../src/main/config'

function configWithKey(apiKey: string): ModelConfig {
  const config = createDefaultModelConfig()
  config.connections = {
    c1: { id: 'c1', label: 'OpenAI', providerType: 'openai', apiKey }
  }
  config.roles.chat = { connectionId: 'c1', model: 'gpt-x' }
  return config
}

function providersFile(): string {
  return join(h.userData, 'config', 'providers.json')
}

function storedKey(): string | undefined {
  return JSON.parse(readFileSync(providersFile(), 'utf-8')).connections.c1.apiKey
}

describe('API key storage', () => {
  beforeEach(() => {
    h.userData = mkdtempSync(join(tmpdir(), 'delta-ai-secrets-'))
    h.encryptionAvailable = true
    h.decryptFails = false
  })

  afterEach(() => {
    rmSync(h.userData, { recursive: true, force: true })
  })

  it('never writes a key in plaintext and reads it back decrypted', () => {
    expect(saveModelConfig(configWithKey('sk-secret')).ok).toBe(true)
    expect(readFileSync(providersFile(), 'utf-8')).not.toContain('"sk-secret"')
    expect(storedKey()?.startsWith('enc:v1:')).toBe(true)
    expect(loadModelConfig().connections.c1.apiKey).toBe('sk-secret')
  })

  it('reseals a legacy plaintext key on load', () => {
    mkdirSync(join(h.userData, 'config'), { recursive: true })
    writeFileSync(providersFile(), JSON.stringify(configWithKey('sk-legacy')))
    expect(loadModelConfig().connections.c1.apiKey).toBe('sk-legacy')
    expect(storedKey()?.startsWith('enc:v1:')).toBe(true)
  })

  it('falls back to plaintext without a keychain', () => {
    h.encryptionAvailable = false
    saveModelConfig(configWithKey('sk-plain'))
    expect(storedKey()).toBe('sk-plain')
  })

  it('keeps an undecryptable key on disk instead of overwriting it', () => {
    saveModelConfig(configWithKey('sk-secret'))
    const sealed = storedKey()
    h.decryptFails = true
    expect(loadModelConfig().connections.c1.apiKey).toBeUndefined()
    expect(storedKey()).toBe(sealed)
  })
})

describe('renderer-facing config', () => {
  it('redacts keys to a hasApiKey flag', () => {
    const redacted = redactModelConfig(configWithKey('sk-secret'))
    expect(redacted.connections.c1.apiKey).toBeUndefined()
    expect(redacted.connections.c1.hasApiKey).toBe(true)
    expect(JSON.stringify(redacted)).not.toContain('sk-secret')
  })

  it('fills in the stored key only when the renderer sent none', () => {
    const stored = configWithKey('sk-stored')
    const withoutKey = { ...stored.connections.c1 }
    delete withoutKey.apiKey
    expect(withStoredApiKey({ ...withoutKey, hasApiKey: true }, stored)).toEqual(
      stored.connections.c1
    )
    expect(withStoredApiKey({ ...withoutKey, apiKey: 'sk-new' }, stored).apiKey).toBe('sk-new')
    // An explicit empty key is the user removing it.
    expect(withStoredApiKey({ ...withoutKey, apiKey: '' }, stored).apiKey).toBe('')
  })
})
