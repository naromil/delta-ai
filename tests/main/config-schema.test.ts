import { describe, expect, it } from 'vitest'
import { migrateModelConfig } from '../../src/main/models/config-schema'
import { MODEL_CONFIG_VERSION, createDefaultModelConfig } from '../../src/shared/models'
import type { ModelConfig } from '../../src/shared/models'

/* ---- v1 fixtures (pre role-based config) ---- */

const v1Google = {
  currentProvider: 'google-ai-studio',
  providers: {
    'google-ai-studio': {
      apiKey: 'test-token-a',
      model: 'gemini-3.6-flash',
      webSearchEnabled: true
    },
    'openai-compatible': {
      apiKey: 'test-token-b',
      baseUrl: 'https://example.invalid/v1',
      model: 'local-model'
    }
  }
}

function v2Config(): ModelConfig {
  return {
    schemaVersion: MODEL_CONFIG_VERSION,
    connections: {
      conn_a: { id: 'conn_a', label: 'OpenAI', providerType: 'openai', apiKey: 'test-token-a' },
      conn_b: {
        id: 'conn_b',
        label: 'Ollama',
        providerType: 'ollama',
        host: 'http://localhost:11434'
      }
    },
    roles: {
      chat: { connectionId: 'conn_a', model: 'gpt-5-mini', webSearchEnabled: true },
      lookup: { connectionId: 'conn_a', model: 'gpt-5-nano', webSearchEnabled: false },
      'kb-maintenance': { connectionId: 'conn_b', model: 'qwen3:4b', webSearchEnabled: false }
    }
  }
}

describe('v1 -> v2 migration', () => {
  it('turns each provider entry into a connection and assigns the active one', () => {
    const { config, ok, changed } = migrateModelConfig(v1Google)

    expect(ok).toBe(true)
    expect(changed).toBe(true)
    expect(config.schemaVersion).toBe(2)
    expect(Object.keys(config.connections).sort()).toEqual([
      'v1_google-ai-studio',
      'v1_openai-compatible'
    ])

    const google = config.connections['v1_google-ai-studio']
    expect(google).toMatchObject({
      id: 'v1_google-ai-studio',
      label: 'Google AI Studio',
      providerType: 'google-ai-studio',
      apiKey: 'test-token-a'
    })

    // The custom endpoint keeps its base URL; both chat roles inherit the active model.
    expect(config.connections['v1_openai-compatible'].baseUrl).toBe('https://example.invalid/v1')
    expect(config.roles.chat).toEqual({
      connectionId: 'v1_google-ai-studio',
      model: 'gemini-3.6-flash',
      webSearchEnabled: true
    })
    expect(config.roles.lookup).toEqual(config.roles.chat)
    expect(config.roles['kb-maintenance']).toEqual({
      connectionId: null,
      model: '',
      webSearchEnabled: false
    })
  })

  it('falls back to the only provider when currentProvider does not match', () => {
    const { config, notes } = migrateModelConfig({
      currentProvider: 'gone',
      providers: {
        'openai-compatible': {
          apiKey: 'test-token-b',
          model: 'm',
          baseUrl: 'https://x/v1'
        }
      }
    })

    expect(config.roles.chat.connectionId).toBe('v1_openai-compatible')
    expect(config.roles.chat.model).toBe('m')
    expect(notes.join(' ')).toContain('no matching active provider')
  })
})

describe('current schema', () => {
  it('leaves a valid v2 config untouched', () => {
    const { config, ok, changed, notes } = migrateModelConfig(v2Config())

    expect(ok).toBe(true)
    expect(changed).toBe(false)
    expect(notes).toEqual([])
    expect(config).toEqual(v2Config())
  })

  it('unassigns roles that point at a deleted connection', () => {
    const broken = v2Config()
    delete broken.connections.conn_b

    const { config, changed, notes } = migrateModelConfig(broken)
    expect(changed).toBe(true)
    expect(config.roles['kb-maintenance']).toEqual({
      connectionId: null,
      model: '',
      webSearchEnabled: false
    })
    expect(notes.join(' ')).toContain('referenced missing connection "conn_b"')
    // Sibling roles survive untouched.
    expect(config.roles.chat.connectionId).toBe('conn_a')
  })

  it('drops connections with an unknown provider type but keeps the rest', () => {
    const config = v2Config()
    config.connections.conn_c = {
      id: 'conn_c',
      label: 'Mystery',
      providerType: 'gone-provider' as ModelConfig['connections'][string]['providerType']
    }
    config.roles.lookup = { connectionId: 'conn_c', model: 'x', webSearchEnabled: false }

    const result = migrateModelConfig(config)
    expect(result.ok).toBe(true)
    expect(result.config.connections.conn_c).toBeUndefined()
    expect(result.config.roles.lookup.connectionId).toBeNull()
    expect(result.notes.join(' ')).toContain('unknown provider type')
  })

  it('fills a missing role and repairs unlabelled connections', () => {
    const { config, notes } = migrateModelConfig({
      schemaVersion: 2,
      connections: { c1: { id: 'c1', providerType: 'openai' } },
      roles: {}
    })

    expect(config.connections.c1.label).toBe('OpenAI')
    expect(config.roles.chat.connectionId).toBeNull()
    expect(notes.join(' ')).toContain('role "chat" was missing')
    expect(notes.join(' ')).toContain('had no label')
  })

  it('keeps a config written by a newer version readable', () => {
    const future = { ...v2Config(), schemaVersion: 99 }
    const { config, ok, notes } = migrateModelConfig(future)

    expect(ok).toBe(true)
    expect(config.schemaVersion).toBe(MODEL_CONFIG_VERSION)
    expect(config.roles.chat.model).toBe('gpt-5-mini')
    expect(notes.join(' ')).toContain('newer than supported')
  })
})

describe('unusable input', () => {
  it.each([null, undefined, 7, 'text', [1, 2, 3]])('reports %s as unusable', (raw) => {
    const { config, ok, changed, notes } = migrateModelConfig(raw)

    expect(ok).toBe(false)
    expect(changed).toBe(false)
    expect(notes.length).toBeGreaterThan(0)
    expect(config).toEqual(createDefaultModelConfig())
  })

  it('resets when the connections block cannot be parsed', () => {
    const { ok, config } = migrateModelConfig({ schemaVersion: 2, connections: 'nope', roles: {} })
    expect(ok).toBe(false)
    expect(config.connections).toEqual({})
  })
})

describe('default config isolation', () => {
  it('hands out independent role objects', () => {
    const first = createDefaultModelConfig()
    const second = createDefaultModelConfig()
    first.roles.chat.model = 'mutated'
    expect(second.roles.chat.model).toBe('')
  })
})
