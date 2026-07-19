import { loadCurrentProviderConfig } from './config'

export interface ProviderMessage {
  role: string
  content: string
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

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim()
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
}

export async function* callProviderStream(
  messages: ProviderMessage[],
  webSearchEnabled = false
): AsyncGenerator<string> {
  const config = loadCurrentProviderConfig()
  if (!config || !config.apiKey) {
    throw new NoApiKeyError('No API key configured. Open Settings to add your provider API key.')
  }

  switch (config.provider) {
    case 'google-ai-studio':
      if (webSearchEnabled) {
        yield* callGeminiWithSearchStream(config.apiKey, config.model, messages)
      } else {
        yield* callOpenAICompatibleStream(
          config.apiKey,
          config.model,
          messages,
          'https://generativelanguage.googleapis.com/v1beta'
        )
      }
      break
    case 'openai-compatible':
      if (!config.baseUrl) {
        throw new NoApiKeyError('Base URL is required for OpenAI Compatible provider.')
      }
      yield* callOpenAICompatibleStream(
        config.apiKey,
        config.model,
        messages,
        config.baseUrl,
        webSearchEnabled
      )
      break
    default:
      throw new UnsupportedProviderError(`Provider "${config.provider}" is not supported yet.`)
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

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
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

  const res = await fetch(url, {
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
    const parts = content?.parts as Array<{ text: string }> | undefined
    return parts?.[0]?.text
  })
}

/* ---- Non-streaming (kept for chat window) ---- */

export async function callProvider(
  messages: ProviderMessage[],
  webSearchEnabled = false
): Promise<string> {
  const config = loadCurrentProviderConfig()
  if (!config || !config.apiKey) {
    throw new NoApiKeyError('No API key configured. Open Settings to add your provider API key.')
  }

  switch (config.provider) {
    case 'google-ai-studio':
      if (webSearchEnabled) {
        return await callGeminiWithSearch(config.apiKey, config.model, messages)
      }
      return await callOpenAICompatible(
        config.apiKey,
        config.model,
        messages,
        'https://generativelanguage.googleapis.com/v1beta'
      )
    case 'openai-compatible':
      if (!config.baseUrl) {
        throw new NoApiKeyError('Base URL is required for OpenAI Compatible provider.')
      }
      return await callOpenAICompatible(
        config.apiKey,
        config.model,
        messages,
        config.baseUrl,
        webSearchEnabled
      )
    default:
      throw new UnsupportedProviderError(`Provider "${config.provider}" is not supported yet.`)
  }
}

async function callOpenAICompatible(
  apiKey: string,
  model: string,
  messages: ProviderMessage[],
  baseUrl: string,
  webSearchEnabled = false
): Promise<string> {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  const url = `${normalizedBaseUrl}/chat/completions`

  const body: Record<string, unknown> = {
    model,
    messages
  }

  if (webSearchEnabled) {
    body.tools = [{ type: 'web_search' }]
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`API error ${res.status}: ${errText}`)
  }

  const data = await res.json()
  const text: string = data?.choices?.[0]?.message?.content ?? '(No response received)'
  return text
}

async function callGeminiWithSearch(
  apiKey: string,
  model: string,
  messages: ProviderMessage[]
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

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

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Gemini API error ${res.status}: ${errText}`)
  }

  const data = await res.json()

  if (data.promptFeedback?.blockReason) {
    throw new Error(`Request blocked: ${data.promptFeedback.blockReason}`)
  }

  const candidate = data?.candidates?.[0]
  if (!candidate) {
    throw new Error('No response from Gemini API')
  }

  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    throw new Error(`Gemini request terminated: ${candidate.finishReason}`)
  }

  const text: string = candidate?.content?.parts?.[0]?.text ?? '(No response received)'
  return text
}
