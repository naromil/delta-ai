import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// model-catalog.ts reads `userData` from Electron; the stub resolves it lazily so
// the directory can be created after module evaluation.
const testDirs = { userDataDir: '' }

vi.mock('electron', () => ({
  app: { getPath: (): string => testDirs.userDataDir },
  ipcMain: { handle: vi.fn() }
}))

import {
  fetchCatalog,
  getModelCatalog,
  readCachedCatalog,
  resetModelCatalogCache,
  writeCachedCatalog
} from '../../src/main/services/model-catalog'
import { buildModelCatalog } from '../../src/shared/model-catalog'

testDirs.userDataDir = mkdtempSync(join(tmpdir(), 'delta-catalog-'))

const cachePath = (): string => join(testDirs.userDataDir, 'cache', 'models-dev.json')

const payload = {
  openai: { models: { 'gpt-5-mini': { name: 'GPT-5 Mini', tool_call: true } } },
  google: { models: { 'gemini-4-flash': { name: 'Gemini 4 Flash', tool_call: true } } },
  groq: { models: { 'llama-x': { name: 'Llama X' } } }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function failingFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new Error('offline')
  }) as unknown as typeof fetch
}

describe('fetchCatalog', () => {
  it('builds a catalog from the network payload and drops unknown providers', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch
    const catalog = await fetchCatalog(fetchImpl)

    expect(Object.keys(catalog.providers).sort()).toEqual(['google-ai-studio', 'openai'])
    expect(catalog.providers.openai).toHaveLength(1)
    expect(Date.parse(catalog.fetchedAt)).not.toBeNaN()
  })

  it('fails loudly on a non-200 response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503)) as unknown as typeof fetch
    await expect(fetchCatalog(fetchImpl)).rejects.toThrow('models.dev returned 503')
  })

  it('fails loudly when the payload holds no usable providers', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ groq: payload.groq })
    ) as unknown as typeof fetch
    await expect(fetchCatalog(fetchImpl)).rejects.toThrow('no usable providers')
  })
})

describe('disk cache', () => {
  beforeEach(() => {
    rmSync(join(testDirs.userDataDir, 'cache'), { recursive: true, force: true })
  })

  it('returns null when nothing has been cached', () => {
    expect(readCachedCatalog(cachePath())).toBeNull()
  })

  it('round-trips a catalog', () => {
    const catalog = buildModelCatalog(payload, '2026-10-21T00:00:00.000Z')
    writeCachedCatalog(cachePath(), catalog)
    expect(readCachedCatalog(cachePath())).toEqual(catalog)
  })

  it('ignores a corrupt or outdated cache file', () => {
    writeCachedCatalog(cachePath(), buildModelCatalog(payload, 'now'))

    writeFileSync(cachePath(), '{"version":999,"catalog":{}}', 'utf-8')
    expect(readCachedCatalog(cachePath())).toBeNull()

    writeFileSync(cachePath(), 'not json', 'utf-8')
    expect(readCachedCatalog(cachePath())).toBeNull()
  })
})

describe('getModelCatalog', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    resetModelCatalogCache()
    rmSync(join(testDirs.userDataDir, 'cache'), { recursive: true, force: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(join(testDirs.userDataDir, 'cache'), { recursive: true, force: true })
  })

  it('fetches, persists, and reports the network as the source', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(payload))
    )

    const state = await getModelCatalog()
    expect(state.source).toBe('network')
    expect(state.catalog?.providers.openai).toHaveLength(1)
    expect(readCachedCatalog(cachePath())).not.toBeNull()
  })

  it('serves a fresh in-memory snapshot without touching the network', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(payload))
    )
    await getModelCatalog()

    const network = vi.fn(async () => jsonResponse(payload))
    vi.stubGlobal('fetch', network)

    const state = await getModelCatalog()
    expect(state.source).toBe('cache')
    expect(state.error).toBeUndefined()
    expect(network).not.toHaveBeenCalled()
  })

  it('falls back to a stale cached copy when the network is down', async () => {
    const stale = buildModelCatalog(payload, new Date(Date.now() - 48 * 3600 * 1000).toISOString())
    writeCachedCatalog(cachePath(), stale)
    vi.stubGlobal('fetch', failingFetch())

    const state = await getModelCatalog()
    expect(state.source).toBe('cache')
    expect(state.error).toBe('offline')
    expect(state.catalog?.fetchedAt).toBe(stale.fetchedAt)
  })

  it('reports unavailable when there is neither network nor cache', async () => {
    vi.stubGlobal('fetch', failingFetch())

    const state = await getModelCatalog()
    expect(state).toEqual({ catalog: null, source: 'unavailable', error: 'offline' })
  })

  it('refreshes when forced', async () => {
    vi.stubGlobal('fetch', failingFetch())
    await getModelCatalog()

    const network = vi.fn(async () => jsonResponse(payload))
    vi.stubGlobal('fetch', network)

    const state = await getModelCatalog({ force: true })
    expect(state.source).toBe('network')
    expect(network).toHaveBeenCalledTimes(1)
  })
})
