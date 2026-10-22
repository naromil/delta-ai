import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { app, ipcMain } from 'electron'
import { buildModelCatalog, isCatalogFresh } from '../../shared/model-catalog'
import type { ModelCatalog, ModelCatalogState } from '../../shared/model-catalog'

const CATALOG_URL = 'https://models.dev/api.json'
const FETCH_TIMEOUT_MS = 20_000
const CACHE_VERSION = 1

let memoryCache: ModelCatalog | null = null
let inFlight: Promise<ModelCatalogState> | null = null

/* ---- Disk cache ---- */

function catalogCachePath(): string {
  return join(app.getPath('userData'), 'cache', 'models-dev.json')
}

interface CachedCatalogFile {
  version: number
  catalog: ModelCatalog
}

export function readCachedCatalog(cachePath: string): ModelCatalog | null {
  try {
    if (!existsSync(cachePath)) return null
    const parsed = JSON.parse(readFileSync(cachePath, 'utf-8')) as Partial<CachedCatalogFile>
    const catalog = parsed.catalog
    if (parsed.version !== CACHE_VERSION || !catalog || typeof catalog.fetchedAt !== 'string') {
      return null
    }
    if (!catalog.providers || typeof catalog.providers !== 'object') return null
    return catalog
  } catch (err) {
    console.warn(`Failed to read model catalog cache at ${cachePath}:`, err)
    return null
  }
}

export function writeCachedCatalog(cachePath: string, catalog: ModelCatalog): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true })
    const payload: CachedCatalogFile = { version: CACHE_VERSION, catalog }
    writeFileSync(cachePath, JSON.stringify(payload), 'utf-8')
  } catch (err) {
    console.warn(`Failed to write model catalog cache at ${cachePath}:`, err)
  }
}

/* ---- Network ---- */

/** Downloads and flattens the models.dev catalog. Throws on transport/shape errors. */
export async function fetchCatalog(fetchImpl: typeof fetch = fetch): Promise<ModelCatalog> {
  const res = await fetchImpl(CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`models.dev returned ${res.status}`)

  const catalog = buildModelCatalog(await res.json(), new Date().toISOString())
  if (Object.keys(catalog.providers).length === 0) {
    throw new Error('models.dev response contained no usable providers')
  }
  return catalog
}

/* ---- Resolution ---- */

async function refreshCatalog(cachePath: string): Promise<ModelCatalogState> {
  try {
    const catalog = await fetchCatalog()
    memoryCache = catalog
    writeCachedCatalog(cachePath, catalog)
    return { catalog, source: 'network' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const stale = memoryCache ?? readCachedCatalog(cachePath)
    if (stale) return { catalog: stale, source: 'cache', error: message }
    return { catalog: null, source: 'unavailable', error: message }
  }
}

/** Drops the in-memory snapshot so the next call re-reads the cache or network. */
export function resetModelCatalogCache(): void {
  memoryCache = null
}

/**
 * Returns the provider model catalog, preferring a fresh in-memory or on-disk
 * snapshot and falling back to stale data when the network is unavailable.
 */
export async function getModelCatalog(opts: { force?: boolean } = {}): Promise<ModelCatalogState> {
  if (!opts.force) {
    if (memoryCache && isCatalogFresh(memoryCache)) return { catalog: memoryCache, source: 'cache' }

    const cached = readCachedCatalog(catalogCachePath())
    if (cached) {
      memoryCache = cached
      if (isCatalogFresh(cached)) return { catalog: cached, source: 'cache' }
    }
  }

  if (inFlight) return inFlight
  inFlight = refreshCatalog(catalogCachePath()).finally(() => {
    inFlight = null
  })
  return inFlight
}

/* ---- IPC ---- */

export function registerModelCatalogIpcHandlers(): void {
  ipcMain.handle('load-model-catalog', (_event, force?: boolean): Promise<ModelCatalogState> =>
    getModelCatalog({ force: force === true })
  )
}
