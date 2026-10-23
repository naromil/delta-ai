import { APICallError, JSONParseError, TypeValidationError, streamText } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { resolveRole, RoleUnassignedError } from './config'
import type { Connection } from './models/registries'
import type { ProviderMessage, ProviderType, RoleId } from './models/registries'
export type { ProviderMessage }
export { RoleUnassignedError }

const FETCH_TIMEOUT_MS = 40_000
const TIMEOUT_MESSAGE = `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s. Check your API endpoint and network connection.`
const CANCEL_MESSAGE = 'Generation stopped.'

export class NoApiKeyError extends Error {}
export class UnsupportedProviderError extends Error {}

/* ---- Routes ---- */

/**
 * Every provider speaks the OpenAI-compatible wire format, so a provider is a name
 * plus a default base URL. Nothing downstream branches on the provider type; adding
 * one means adding a row here. Google uses its OpenAI-compatible endpoint rather
 * than a dedicated SDK, so it gets no special treatment.
 */
interface ProviderRoute {
  name: string
  /** Used when the connection does not carry its own base URL. */
  baseUrl?: string
  requiresApiKey: boolean
}

const ROUTES: Record<ProviderType, ProviderRoute> = {
  'google-ai-studio': {
    name: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    requiresApiKey: true
  },
  openai: {
    name: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true
  },
  openrouter: {
    name: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true
  },
  'openai-compatible': {
    name: 'openai-compatible',
    requiresApiKey: true
  },
  ollama: {
    name: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false
  }
}

function stripTrailingSlashes(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function baseUrlFor(connection: Connection, route: ProviderRoute): string {
  if (connection.providerType === 'ollama') {
    const host = stripTrailingSlashes(connection.host ?? 'http://localhost:11434')
    return stripTrailingSlashes(connection.baseUrl || `${host}/v1`)
  }
  const baseUrl = stripTrailingSlashes(connection.baseUrl ?? route.baseUrl ?? '')
  if (!baseUrl) {
    throw new NoApiKeyError('Base URL is required for OpenAI Compatible provider.')
  }
  return baseUrl
}

/* ---- AI SDK transport ---- */

function splitPrompt(messages: ProviderMessage[]): {
  instructions: Array<{ role: 'system'; content: string }> | undefined
  messages: ModelMessage[]
} {
  const systemMessages = messages.filter((message) => message.role === 'system')
  return {
    instructions:
      systemMessages.length > 0
        ? systemMessages.map((message) => ({ role: 'system' as const, content: message.content }))
        : undefined,
    messages: messages.filter((message) => message.role !== 'system') as ModelMessage[]
  }
}

const API_ERROR_BODY_LIMIT = 500

function translateError(error: unknown): Error {
  if (APICallError.isInstance(error)) {
    if (error.statusCode === undefined) return new Error(error.message)
    const body = (error.responseBody ?? '').trim()
    const detail =
      body.length > API_ERROR_BODY_LIMIT ? `${body.slice(0, API_ERROR_BODY_LIMIT)}…` : body
    return new Error(
      detail ? `API error ${error.statusCode}: ${detail}` : `API error ${error.statusCode}`
    )
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new Error(TIMEOUT_MESSAGE)
  }
  return error instanceof Error ? error : new Error(String(error))
}

async function* streamModel(
  model: LanguageModel,
  messages: ProviderMessage[],
  externalSignal?: AbortSignal
): AsyncGenerator<string> {
  const prompt = splitPrompt(messages)
  const controller = new AbortController()
  let timedOut = false
  let timer: NodeJS.Timeout | undefined

  // The limit is an *idle* timeout: a long answer that keeps producing tokens
  // must not be cut off at 40s, but a stalled connection must be.
  const armTimeout = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, FETCH_TIMEOUT_MS)
  }
  armTimeout()

  const onExternalAbort = (): void => controller.abort()
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }

  try {
    const result = streamText({
      model,
      instructions: prompt.instructions,
      messages: prompt.messages,
      maxRetries: 0,
      abortSignal: controller.signal
    })

    for await (const part of result.fullStream) {
      armTimeout()
      if (part.type === 'text-delta') {
        yield part.text
      } else if (part.type === 'error') {
        if (!JSONParseError.isInstance(part.error) && !TypeValidationError.isInstance(part.error)) {
          throw part.error
        }
      } else if (part.type === 'abort') {
        throw new Error(TIMEOUT_MESSAGE)
      }
    }
  } catch (error) {
    if (externalSignal?.aborted) throw new Error(CANCEL_MESSAGE)
    if (timedOut) throw new Error(TIMEOUT_MESSAGE)
    throw translateError(error)
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}

/* ---- Public dispatch ---- */

export async function* callProviderStream(
  messages: ProviderMessage[],
  roleId: RoleId,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const resolved = resolveRole(roleId)
  if (!resolved) {
    throw new RoleUnassignedError(roleId)
  }
  const { connection, model } = resolved
  const route = ROUTES[connection.providerType]
  if (!route) {
    throw new UnsupportedProviderError(
      `Provider "${connection.providerType}" is not supported yet.`
    )
  }
  if (route.requiresApiKey && !connection.apiKey) {
    throw new NoApiKeyError('No API key configured. Open Settings to add your provider API key.')
  }

  const provider = createOpenAICompatible({
    name: route.name,
    baseURL: baseUrlFor(connection, route),
    apiKey: connection.apiKey || undefined
  })

  yield* streamModel(provider(model), messages, signal)
}

/* ---- Non-streaming: drain the single streaming dispatch ---- */

export async function callProvider(
  messages: ProviderMessage[],
  roleId: RoleId,
  signal?: AbortSignal
): Promise<string> {
  let response = ''
  for await (const chunk of callProviderStream(messages, roleId, signal)) {
    response += chunk
  }
  return response || '(No response received)'
}
