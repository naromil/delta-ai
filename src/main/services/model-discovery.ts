import { z } from 'zod'
import { providerRegistry } from '../models/registries'
import type { Connection } from '../models/registries'

export interface DiscoveredModels {
  models: string[]
  error?: string
}

export interface ConnectionTestResult {
  ok: boolean
  detail: string
  modelCount?: number
}

const FETCH_TIMEOUT_MS = 8_000
const DEFAULT_OLLAMA_HOST = 'http://localhost:11434'
const GOOGLE_MODELS_URL = `${providerRegistry['google-ai-studio'].defaultBaseUrl}/models`

/* ---- Response parsing ---- */

const ollamaResponseSchema = z.object({
  models: z.array(z.object({ name: z.string() })).default([])
})

const openAiResponseSchema = z.object({
  data: z.array(z.object({ id: z.string() })).default([])
})

const googleResponseSchema = z.object({
  models: z
    .array(
      z.object({
        name: z.string(),
        supportedGenerationMethods: z.array(z.string()).default([])
      })
    )
    .default([])
})

function readOllamaModels(payload: unknown): string[] {
  const parsed = ollamaResponseSchema.safeParse(payload)
  if (!parsed.success) return []
  return parsed.data.models.map((model) => model.name).filter((name) => name.length > 0)
}

function readOpenAiModels(payload: unknown): string[] {
  const parsed = openAiResponseSchema.safeParse(payload)
  if (!parsed.success) return []
  return parsed.data.data.map((model) => model.id).filter((id) => id.length > 0)
}

function readGoogleModels(payload: unknown): string[] {
  const parsed = googleResponseSchema.safeParse(payload)
  if (!parsed.success) return []
  return parsed.data.models.flatMap((model) => {
    if (!model.supportedGenerationMethods.includes('generateContent')) return []
    const id = model.name.startsWith('models/') ? model.name.slice('models/'.length) : model.name
    return id.length > 0 ? [id] : []
  })
}

function parseModels(connection: Connection, payload: unknown): string[] {
  switch (connection.providerType) {
    case 'ollama':
      return readOllamaModels(payload)
    case 'google-ai-studio':
      return readGoogleModels(payload)
    default:
      return readOpenAiModels(payload)
  }
}

/* ---- Endpoint helpers ---- */

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

function resolveBaseUrl(connection: Connection): string | null {
  if (connection.providerType === 'ollama') {
    return stripTrailingSlashes(connection.host?.trim() || DEFAULT_OLLAMA_HOST)
  }
  const baseUrl =
    connection.baseUrl?.trim() || providerRegistry[connection.providerType]?.defaultBaseUrl
  return baseUrl ? stripTrailingSlashes(baseUrl) : null
}

function missingBaseUrlError(connection: Connection): string {
  if (connection.providerType === 'openai-compatible') {
    return 'Base URL is required for OpenAI Compatible provider.'
  }
  return `Base URL is required for ${providerRegistry[connection.providerType]?.label ?? 'this'} provider.`
}

function authHeaders(connection: Connection): Record<string, string> {
  if (!connection.apiKey) return {}
  if (connection.providerType === 'google-ai-studio') {
    return { 'x-goog-api-key': connection.apiKey }
  }
  if (connection.providerType === 'ollama') return {}
  return { Authorization: `Bearer ${connection.apiKey}` }
}

function httpError(status: number, statusText: string): string {
  return statusText ? `HTTP ${status}: ${statusText}` : `HTTP ${status}`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function fetchWithTimeout(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch
): Promise<Response> {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
}

/* ---- Discovery ---- */

export async function discoverConnectionModels(
  connection: Connection,
  fetchImpl: typeof fetch = fetch
): Promise<DiscoveredModels> {
  try {
    const baseUrl = resolveBaseUrl(connection)
    if (!baseUrl) return { models: [], error: missingBaseUrlError(connection) }

    const url =
      connection.providerType === 'google-ai-studio'
        ? GOOGLE_MODELS_URL
        : connection.providerType === 'ollama'
          ? `${baseUrl}/api/tags`
          : `${baseUrl}/models`
    const response = await fetchWithTimeout(
      url,
      { method: 'GET', headers: authHeaders(connection) },
      fetchImpl
    )
    if (!response.ok) {
      return { models: [], error: httpError(response.status, response.statusText) }
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return { models: [], error: `Invalid JSON response from ${url}` }
    }
    return { models: [...new Set(parseModels(connection, payload))].sort() }
  } catch (err) {
    return { models: [], error: errorMessage(err) }
  }
}

/* ---- Connection test ---- */

function parseHttpStatus(error: string | undefined): number | null {
  if (!error) return null
  const match = /^HTTP (\d{3})\b/.exec(error)
  return match ? Number(match[1]) : null
}

async function probeConnection(
  connection: Connection,
  probeModel: string,
  listStatus: number,
  fetchImpl: typeof fetch
): Promise<ConnectionTestResult> {
  try {
    const baseUrl = resolveBaseUrl(connection)
    if (!baseUrl) return { ok: false, detail: missingBaseUrlError(connection) }

    const response = await fetchWithTimeout(
      `${baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(connection) },
        body: JSON.stringify({
          model: probeModel,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false
        })
      },
      fetchImpl
    )

    if (response.ok) {
      return { ok: true, detail: `Endpoint reachable (no model list: HTTP ${listStatus})` }
    }
    if (response.status === 401) {
      return { ok: false, detail: `API key rejected (HTTP ${response.status})` }
    }
    return { ok: false, detail: httpError(response.status, response.statusText) }
  } catch (err) {
    return { ok: false, detail: errorMessage(err) }
  }
}

export async function testConnection(
  connection: Connection,
  probeModel?: string,
  fetchImpl: typeof fetch = fetch
): Promise<ConnectionTestResult> {
  try {
    const discovery = await discoverConnectionModels(connection, fetchImpl)
    if (discovery.models.length > 0) {
      const modelCount = discovery.models.length
      return { ok: true, detail: `${modelCount} models available`, modelCount }
    }

    const status = parseHttpStatus(discovery.error)

    if (status === 401) {
      return { ok: false, detail: `API key rejected (HTTP ${status})` }
    }
    if (status === 403 && connection.providerType === 'google-ai-studio') {
      return { ok: false, detail: `API key rejected (HTTP ${status})` }
    }
    if (probeModel && (status === 403 || status === 404 || status === 405)) {
      return probeConnection(connection, probeModel, status, fetchImpl)
    }
    if (status === null) {
      return { ok: false, detail: discovery.error ?? 'No models available' }
    }
    if (probeModel) {
      return { ok: false, detail: discovery.error ?? `HTTP ${status}` }
    }

    return {
      ok: false,
      detail: `Endpoint reports no models (HTTP ${status}); pick a model to probe`
    }
  } catch (err) {
    return { ok: false, detail: errorMessage(err) }
  }
}
