import type { ProviderType } from './models'

/**
 * models.dev provider ids for every provider type we can enumerate from the
 * public catalog. Types absent here (custom OpenAI-compatible endpoints,
 * Ollama) must be discovered from the endpoint itself.
 */
export const CATALOG_PROVIDER_IDS: Partial<Record<ProviderType, string>> = {
  'google-ai-studio': 'google',
  openai: 'openai',
  openrouter: 'openrouter'
}

/** A single language model, flattened from the models.dev payload. */
export interface CatalogModel {
  id: string
  name: string
  contextWindow?: number
  maxOutput?: number
  toolCall: boolean
  reasoning: boolean
  structuredOutput: boolean
  inputModalities: string[]
  /** USD per 1M input tokens. */
  costIn?: number
  /** USD per 1M output tokens. */
  costOut?: number
}

export interface ModelCatalog {
  /** ISO timestamp of the catalog snapshot. */
  fetchedAt: string
  providers: Partial<Record<ProviderType, CatalogModel[]>>
}

export type ModelCatalogSource = 'network' | 'cache' | 'unavailable'

export interface ModelCatalogState {
  catalog: ModelCatalog | null
  source: ModelCatalogSource
  error?: string
}

export const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000

/* ---- Defensive readers ---- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readRecord(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {}
}

/* ---- Catalog building ---- */

function buildCatalogModel(id: string, raw: unknown): CatalogModel | null {
  const model = asRecord(raw)
  if (!model) return null
  // Specialised model types (image, speech, transcription) share the payload.
  if (model.type !== undefined && model.type !== 'language') return null

  const limit = readRecord(model.limit)
  const cost = readRecord(model.cost)
  const input = readRecord(model.modalities).input

  return {
    id,
    name: readString(model.name) ?? id,
    contextWindow: readNumber(limit.context),
    maxOutput: readNumber(limit.output),
    toolCall: model.tool_call === true,
    reasoning: model.reasoning === true,
    structuredOutput: model.structured_output === true,
    inputModalities: Array.isArray(input)
      ? input.filter((m): m is string => typeof m === 'string')
      : [],
    costIn: readNumber(cost.input),
    costOut: readNumber(cost.output)
  }
}

function buildProviderModels(raw: unknown): CatalogModel[] {
  const provider = asRecord(raw)
  if (!provider) return []
  const models = readRecord(provider.models)

  const built: CatalogModel[] = []
  for (const [id, model] of Object.entries(models)) {
    const entry = buildCatalogModel(id, model)
    if (entry) built.push(entry)
  }
  return built.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Flattens a models.dev `api.json` payload into per-provider model lists,
 * keeping only the provider types Delta AI can dispatch to.
 */
export function buildModelCatalog(raw: unknown, fetchedAt: string): ModelCatalog {
  const providers = asRecord(raw) ?? {}
  const result: ModelCatalog['providers'] = {}

  for (const [providerType, catalogId] of Object.entries(CATALOG_PROVIDER_IDS)) {
    const models = buildProviderModels(providers[catalogId])
    if (models.length > 0) {
      result[providerType as ProviderType] = models
    }
  }

  return { fetchedAt, providers: result }
}

/* ---- Accessors ---- */

export function catalogModelsForType(
  catalog: ModelCatalog | null,
  providerType: ProviderType | undefined
): CatalogModel[] {
  if (!catalog || !providerType) return []
  return catalog.providers[providerType] ?? []
}

export function findCatalogModel(
  catalog: ModelCatalog | null,
  providerType: ProviderType | undefined,
  modelId: string
): CatalogModel | undefined {
  return catalogModelsForType(catalog, providerType).find((m) => m.id === modelId)
}

export function isCatalogFresh(catalog: ModelCatalog, now = Date.now()): boolean {
  const fetchedAt = Date.parse(catalog.fetchedAt)
  if (Number.isNaN(fetchedAt)) return false
  return now - fetchedAt < CATALOG_MAX_AGE_MS
}

/** Compact human label for a context window, e.g. `1M`, `131K`, `8K`. */
export function formatContextWindow(tokens: number | undefined): string | undefined {
  if (!tokens || tokens <= 0) return undefined
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1000)}K`
  return String(tokens)
}

function formatPrice(usdPerMillion: number | undefined): string | undefined {
  if (usdPerMillion === undefined) return undefined
  return `$${Math.round(usdPerMillion * 1000) / 1000}`
}

/** One-line model summary for the settings UI, e.g. `1M context · tools · $1 / $3 per 1M`. */
export function describeCatalogModel(model: CatalogModel): string {
  const parts: string[] = []
  const context = formatContextWindow(model.contextWindow)
  if (context) parts.push(`${context} context`)
  if (model.toolCall) parts.push('tool calls')
  if (model.reasoning) parts.push('reasoning')

  const costIn = formatPrice(model.costIn)
  const costOut = formatPrice(model.costOut)
  if (costIn !== undefined || costOut !== undefined) {
    parts.push(`${costIn ?? '?'} / ${costOut ?? '?'} per 1M`)
  }

  return parts.join(' · ')
}
