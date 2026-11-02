import { APICallError, JSONParseError, TypeValidationError, isStepCount, streamText } from 'ai'
import type { LanguageModel, ModelMessage, ToolSet } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { resolveRole, RoleUnassignedError } from './config'
import type { Connection } from './models/registries'
import type { ProviderMessage, ProviderType, RoleId } from './models/registries'
import { withInstructions } from './streaming'
export type { ProviderMessage }
export { RoleUnassignedError }

const FETCH_TIMEOUT_MS = 40_000
const TIMEOUT_MESSAGE = `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s. Check your API endpoint and network connection.`
const CANCEL_MESSAGE = 'Generation stopped.'

export class NoApiKeyError extends Error {}
export class UnsupportedProviderError extends Error {}
/** The endpoint refused the request itself, which is how a model without tool support fails. */
class RequestRejectedError extends Error {}

/** Application tools for one request; `instructions` joins the system prompt only alongside them. */
export interface AgentTools {
  tools: ToolSet
  instructions: string
  /** Tool steps plus the closing answer; the last step is forced to answer in text. */
  maxSteps: number
  /** The request is pointless without its tools: fail on rejection instead of answering plainly. */
  toolsRequired?: boolean
}

const REJECTED_REQUEST_STATUSES = new Set([400, 404, 422])

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

/** The SDK's OpenAI-compatible route turns `file` parts into `image_url` data URLs. */
function toModelMessage(message: ProviderMessage): ModelMessage {
  const { role, content, images } = message
  if (!images?.length) return { role, content } as ModelMessage
  return {
    role: 'user',
    content: [
      ...(content === '' ? [] : [{ type: 'text' as const, text: content }]),
      ...images.map(({ mediaType, data }) => ({ type: 'file' as const, data, mediaType }))
    ]
  }
}

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
    messages: messages.filter((message) => message.role !== 'system').map(toModelMessage)
  }
}

const API_ERROR_BODY_LIMIT = 500

function translateError(error: unknown): Error {
  if (APICallError.isInstance(error)) {
    if (error.statusCode === undefined) return new Error(error.message)
    const body = (error.responseBody ?? '').trim()
    const detail =
      body.length > API_ERROR_BODY_LIMIT ? `${body.slice(0, API_ERROR_BODY_LIMIT)}…` : body
    const message = detail
      ? `API error ${error.statusCode}: ${detail}`
      : `API error ${error.statusCode}`
    return REJECTED_REQUEST_STATUSES.has(error.statusCode)
      ? new RequestRejectedError(message)
      : new Error(message)
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new Error(TIMEOUT_MESSAGE)
  }
  return error instanceof Error ? error : new Error(String(error))
}

async function* streamModel(
  model: LanguageModel,
  messages: ProviderMessage[],
  externalSignal?: AbortSignal,
  agent?: AgentTools
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
      abortSignal: controller.signal,
      ...(agent && {
        tools: agent.tools,
        stopWhen: isStepCount(agent.maxSteps),
        prepareStep: ({ stepNumber }: { stepNumber: number }) =>
          stepNumber === agent.maxSteps - 1 ? { toolChoice: 'none' as const } : {}
      })
    })

    // Text from separate tool steps must not run together in one answer.
    let hasText = false
    let stepEnded = false
    for await (const part of result.fullStream) {
      armTimeout()
      if (part.type === 'text-delta') {
        if (hasText && stepEnded) yield '\n\n'
        hasText = true
        stepEnded = false
        yield part.text
      } else if (part.type === 'finish-step') {
        stepEnded = true
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

/**
 * Tool support can only be discovered by asking for custom endpoints and Ollama, so a
 * rejected tool request falls back to a plain answer rather than failing the message,
 * unless the caller has no use for an answer without tools.
 */
async function* streamModelWithTools(
  model: LanguageModel,
  messages: ProviderMessage[],
  agent: AgentTools,
  signal?: AbortSignal
): AsyncGenerator<string> {
  let emitted = false
  try {
    const instructed = withInstructions(messages, agent.instructions)
    for await (const chunk of streamModel(model, instructed, signal, agent)) {
      emitted = true
      yield chunk
    }
  } catch (error) {
    if (emitted || agent.toolsRequired || !(error instanceof RequestRejectedError)) throw error
    console.warn('Retrying without tools after the endpoint rejected the request:', error.message)
    yield* streamModel(model, messages, signal)
  }
}

/* ---- Public dispatch ---- */

export async function* callProviderStream(
  messages: ProviderMessage[],
  roleId: RoleId,
  signal?: AbortSignal,
  agent?: AgentTools
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

  if (agent) {
    yield* streamModelWithTools(provider(model), messages, agent, signal)
  } else {
    yield* streamModel(provider(model), messages, signal)
  }
}

/* ---- Non-streaming: drain the single streaming dispatch ---- */

export async function callProvider(
  messages: ProviderMessage[],
  roleId: RoleId,
  signal?: AbortSignal,
  agent?: AgentTools
): Promise<string> {
  let response = ''
  for await (const chunk of callProviderStream(messages, roleId, signal, agent)) {
    response += chunk
  }
  return response || '(No response received)'
}
