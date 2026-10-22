import { describe, expect, it } from 'vitest'
import {
  buildModelCatalog,
  catalogModelsForType,
  describeCatalogModel,
  findCatalogModel,
  formatContextWindow,
  isCatalogFresh,
  CATALOG_MAX_AGE_MS
} from '../../src/shared/model-catalog'

function payload(): unknown {
  return {
    openai: {
      name: 'OpenAI',
      models: {
        'gpt-5-mini': {
          name: 'GPT-5 Mini',
          tool_call: true,
          reasoning: true,
          structured_output: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 400_000, output: 128_000 },
          cost: { input: 0.25, output: 2 }
        },
        'gpt-4o': { name: 'GPT-4o', tool_call: true, limit: { context: 128_000 } }
      }
    },
    google: {
      name: 'Google',
      models: {
        'gemini-4-flash': {
          name: 'Gemini 4 Flash',
          tool_call: true,
          limit: { context: 1_048_576 }
        },
        'imagen-9': { name: 'Imagen 9', type: 'image', tool_call: false }
      }
    },
    // Unsupported by Delta AI: must not reach the renderer.
    groq: { name: 'Groq', models: { 'llama-x': { name: 'Llama X', tool_call: true } } }
  }
}

describe('buildModelCatalog', () => {
  it('keeps only dispatchable providers, language models, sorted by id', () => {
    const catalog = buildModelCatalog(payload(), '2026-10-21T00:00:00.000Z')

    expect(Object.keys(catalog.providers).sort()).toEqual(['google-ai-studio', 'openai'])
    expect(catalog.providers.openai?.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-5-mini'])
    expect(catalog.providers['google-ai-studio']?.map((m) => m.id)).toEqual(['gemini-4-flash'])
    expect(catalog.fetchedAt).toBe('2026-10-21T00:00:00.000Z')
  })

  it('flattens limits, costs, modalities and capability flags', () => {
    const model = findCatalogModel(buildModelCatalog(payload(), 'now'), 'openai', 'gpt-5-mini')

    expect(model).toEqual({
      id: 'gpt-5-mini',
      name: 'GPT-5 Mini',
      contextWindow: 400_000,
      maxOutput: 128_000,
      toolCall: true,
      reasoning: true,
      structuredOutput: true,
      inputModalities: ['text', 'image'],
      costIn: 0.25,
      costOut: 2
    })
  })

  it('survives malformed payloads without throwing', () => {
    for (const raw of [
      null,
      undefined,
      42,
      'nope',
      [],
      { openai: null },
      { openai: { models: 7 } }
    ]) {
      const catalog = buildModelCatalog(raw, 'now')
      expect(catalog.providers).toEqual({})
      expect(catalogModelsForType(catalog, 'openai')).toEqual([])
    }
  })

  it('defaults missing fields instead of dropping the model', () => {
    const catalog = buildModelCatalog({ openrouter: { models: { 'x/y': {} } } }, 'now')
    expect(catalog.providers.openrouter).toEqual([
      {
        id: 'x/y',
        name: 'x/y',
        contextWindow: undefined,
        maxOutput: undefined,
        toolCall: false,
        reasoning: false,
        structuredOutput: false,
        inputModalities: [],
        costIn: undefined,
        costOut: undefined
      }
    ])
  })
})

describe('catalog accessors', () => {
  it('returns an empty list for providers the catalog cannot describe', () => {
    const catalog = buildModelCatalog(payload(), 'now')
    expect(catalogModelsForType(catalog, 'ollama')).toEqual([])
    expect(catalogModelsForType(catalog, 'openai-compatible')).toEqual([])
    expect(catalogModelsForType(null, 'openai')).toEqual([])
    expect(catalogModelsForType(catalog, undefined)).toEqual([])
  })

  it('ignores fetches older than the max age', () => {
    const fresh = buildModelCatalog(payload(), new Date(Date.now() - 1000).toISOString())
    expect(isCatalogFresh(fresh)).toBe(true)
    expect(isCatalogFresh(fresh, Date.now() + CATALOG_MAX_AGE_MS + 1000)).toBe(false)
    expect(isCatalogFresh(buildModelCatalog(payload(), 'not-a-date'))).toBe(false)
  })
})

describe('formatting', () => {
  it('shortens context windows', () => {
    expect(formatContextWindow(1_048_576)).toBe('1M')
    expect(formatContextWindow(400_000)).toBe('400K')
    expect(formatContextWindow(8_192)).toBe('8K')
    expect(formatContextWindow(512)).toBe('512')
    expect(formatContextWindow(undefined)).toBeUndefined()
    expect(formatContextWindow(0)).toBeUndefined()
  })

  it('summarises capabilities and price', () => {
    const [model] = catalogModelsForType(buildModelCatalog(payload(), 'now'), 'openai')
    const gpt5 = findCatalogModel(buildModelCatalog(payload(), 'now'), 'openai', 'gpt-5-mini')
    expect(gpt5 && describeCatalogModel(gpt5)).toBe(
      '400K context · tool calls · reasoning · $0.25 / $2 per 1M'
    )
    // gpt-4o sorts first and carries no cost data
    expect(describeCatalogModel(model)).toBe('128K context · tool calls')
  })
})
