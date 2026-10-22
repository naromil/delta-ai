import { APICallError, JSONParseError, TypeValidationError, streamText } from 'ai'
import type { LanguageModel, ModelMessage, ToolSet } from 'ai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { resolveRole, RoleUnassignedError } from './config'
import type { ProviderMessage, RoleId } from './models/registries'
export type { ProviderMessage }
export { RoleUnassignedError }

const FETCH_TIMEOUT_MS = 40_000
const TIMEOUT_MESSAGE = `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s. Check your API endpoint and network connection.`
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

export class NoApiKeyError extends Error {}
export class UnsupportedProviderError extends Error {}

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

function translateError(error: unknown, prefix: string): Error {
  if (APICallError.isInstance(error)) {
    if (error.statusCode === undefined) return new Error(error.message)
    return new Error(`${prefix} ${error.statusCode}: ${error.responseBody ?? ''}`)
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new Error(TIMEOUT_MESSAGE)
  }
  return error instanceof Error ? error : new Error(String(error))
}

async function* streamModel(
  model: LanguageModel,
  messages: ProviderMessage[],
  { tools, errorPrefix }: { tools?: ToolSet; errorPrefix: string }
): AsyncGenerator<string> {
  const prompt = splitPrompt(messages)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const result = streamText({
      model,
      instructions: prompt.instructions,
      messages: prompt.messages,
      tools,
      maxRetries: 0,
      abortSignal: controller.signal
    })

    for await (const part of result.fullStream) {
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
    throw translateError(error, errorPrefix)
  } finally {
    clearTimeout(timer)
  }
}

async function* streamOpenAIWire(
  apiKey: string,
  modelId: string,
  messages: ProviderMessage[],
  baseUrl: string,
  webSearchEnabled: boolean
): AsyncGenerator<string> {
  const provider = createOpenAICompatible({
    name: 'openai-compatible',
    baseURL: baseUrl,
    apiKey: apiKey || undefined,
    transformRequestBody: webSearchEnabled
      ? (body) => ({ ...body, tools: [{ type: 'web_search' }] })
      : undefined
  })

  yield* streamModel(provider(modelId), messages, { errorPrefix: 'API error' })
}

async function* streamGeminiWithSearch(
  apiKey: string,
  modelId: string,
  messages: ProviderMessage[]
): AsyncGenerator<string> {
  const google = createGoogleGenerativeAI({ apiKey, baseURL: GEMINI_BASE_URL })

  yield* streamModel(google(modelId), messages, {
    tools: { google_search: google.tools.googleSearch({}) },
    errorPrefix: 'Gemini API error'
  })
}

/* ---- Public dispatch ---- */

export async function* callProviderStream(
  messages: ProviderMessage[],
  roleId: RoleId
): AsyncGenerator<string> {
  const resolved = resolveRole(roleId)
  if (!resolved) {
    throw new RoleUnassignedError(roleId)
  }
  const { connection, model, webSearchEnabled } = resolved
  if (!connection.apiKey && connection.providerType !== 'ollama') {
    throw new NoApiKeyError('No API key configured. Open Settings to add your provider API key.')
  }

  switch (connection.providerType) {
    case 'google-ai-studio':
      if (webSearchEnabled) {
        yield* streamGeminiWithSearch(connection.apiKey ?? '', model, messages)
      } else {
        yield* streamOpenAIWire(connection.apiKey ?? '', model, messages, GEMINI_BASE_URL, false)
      }
      break
    case 'openai-compatible':
      if (!connection.baseUrl) {
        throw new NoApiKeyError('Base URL is required for OpenAI Compatible provider.')
      }
      yield* streamOpenAIWire(
        connection.apiKey ?? '',
        model,
        messages,
        connection.baseUrl,
        webSearchEnabled
      )
      break
    case 'openai':
      yield* streamOpenAIWire(
        connection.apiKey ?? '',
        model,
        messages,
        connection.baseUrl ?? 'https://api.openai.com/v1',
        webSearchEnabled
      )
      break
    case 'openrouter':
      yield* streamOpenAIWire(
        connection.apiKey ?? '',
        model,
        messages,
        connection.baseUrl ?? 'https://openrouter.ai/api/v1',
        webSearchEnabled
      )
      break
    case 'ollama': {
      const host = (connection.host ?? 'http://localhost:11434').replace(/\/+$/, '')
      yield* streamOpenAIWire('', model, messages, `${host}/v1`, false)
      break
    }
    default:
      throw new UnsupportedProviderError(
        `Provider "${connection.providerType}" is not supported yet.`
      )
  }
}

/* ---- Non-streaming: drain the single streaming dispatch ---- */

export async function callProvider(messages: ProviderMessage[], roleId: RoleId): Promise<string> {
  let response = ''
  for await (const chunk of callProviderStream(messages, roleId)) {
    response += chunk
  }
  return response || '(No response received)'
}
