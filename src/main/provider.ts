import { resolveRole, RoleUnassignedError } from './config'
import type { ProviderMessage, RoleId } from './models/registries'
export type { ProviderMessage }
export { RoleUnassignedError }

const FETCH_TIMEOUT_MS = 40_000

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    if ((err as DOMException)?.name === 'AbortError') {
      throw new Error(
        `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s. Check your API endpoint and network connection.`
      )
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export class NoApiKeyError extends Error {}
export class UnsupportedProviderError extends Error {}

/* ---- Streaming ---- */

async function* sseStream(
  res: Response,
  extract: (parsed: Record<string, unknown>) => string | undefined
): AsyncGenerator<string> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('Response body is not readable')

  const decoder = new TextDecoder()
  let buffer = ''
  let done = false

  while (!done) {
    const result = await reader.read()
    done = result.done
    if (done) {
      buffer += '\n'
    } else {
      buffer += decoder.decode(result.value, { stream: true })
    }
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data) continue
      if (data === '[DONE]') return

      try {
        const parsed = JSON.parse(data) as Record<string, unknown>
        const chunk = extract(parsed)
        if (chunk) yield chunk
      } catch {
        // skip malformed JSON
      }
    }
  }
}

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
        yield* callGeminiWithSearchStream(connection.apiKey ?? '', model, messages)
      } else {
        yield* callOpenAICompatibleStream(
          connection.apiKey ?? '',
          model,
          messages,
          'https://generativelanguage.googleapis.com/v1beta'
        )
      }
      break
    case 'openai-compatible':
      if (!connection.baseUrl) {
        throw new NoApiKeyError('Base URL is required for OpenAI Compatible provider.')
      }
      yield* callOpenAICompatibleStream(
        connection.apiKey ?? '',
        model,
        messages,
        connection.baseUrl,
        webSearchEnabled
      )
      break
    case 'openai':
      yield* callOpenAICompatibleStream(
        connection.apiKey ?? '',
        model,
        messages,
        connection.baseUrl ?? 'https://api.openai.com/v1',
        webSearchEnabled
      )
      break
    case 'openrouter':
      yield* callOpenAICompatibleStream(
        connection.apiKey ?? '',
        model,
        messages,
        connection.baseUrl ?? 'https://openrouter.ai/api/v1',
        webSearchEnabled
      )
      break
    case 'ollama': {
      const host = (connection.host ?? 'http://localhost:11434').replace(/\/+$/, '')
      yield* callOpenAICompatibleStream('', model, messages, `${host}/v1`, false)
      break
    }
    default:
      throw new UnsupportedProviderError(
        `Provider "${connection.providerType}" is not supported yet.`
      )
  }
}

async function* callOpenAICompatibleStream(
  apiKey: string,
  model: string,
  messages: ProviderMessage[],
  baseUrl: string,
  webSearchEnabled = false
): AsyncGenerator<string> {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  const url = `${normalizedBaseUrl}/chat/completions`

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true
  }

  if (webSearchEnabled) {
    body.tools = [{ type: 'web_search' }]
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  }
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`API error ${res.status}: ${errText}`)
  }

  yield* sseStream(res, (parsed) => {
    const choice = (parsed?.choices as Array<Record<string, unknown>> | undefined)?.[0]
    return (choice?.delta as Record<string, unknown> | undefined)?.content as string | undefined
  })
}

async function* callGeminiWithSearchStream(
  apiKey: string,
  model: string,
  messages: ProviderMessage[]
): AsyncGenerator<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`

  let systemInstruction: string | null = null
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = []

  for (const msg of messages) {
    if (msg.role === 'system' && !systemInstruction) {
      systemInstruction = msg.content
    } else if (msg.role === 'system') {
      contents.push({ role: 'user', parts: [{ text: msg.content }] })
    } else {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
      })
    }
  }

  const body: Record<string, unknown> = {
    contents,
    tools: [{ googleSearch: {} }]
  }

  if (systemInstruction) {
    body.system_instruction = { parts: [{ text: systemInstruction }] }
  }

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Gemini API error ${res.status}: ${errText}`)
  }

  yield* sseStream(res, (parsed) => {
    const candidates = parsed?.candidates as Array<Record<string, unknown>> | undefined
    const candidate = candidates?.[0]
    const content = candidate?.content as Record<string, unknown> | undefined
    const parts = content?.parts as Array<{ text?: string }> | undefined
    if (!parts) return undefined
    const text = parts.map((part) => part.text ?? '').join('')
    return text || undefined
  })
}

/* ---- Non-streaming: drain the single streaming dispatch ---- */

export async function callProvider(messages: ProviderMessage[], roleId: RoleId): Promise<string> {
  let response = ''
  for await (const chunk of callProviderStream(messages, roleId)) {
    response += chunk
  }
  return response || '(No response received)'
}
