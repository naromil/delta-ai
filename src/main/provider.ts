import { loadCurrentProviderConfig } from './config'

export interface ProviderMessage {
  role: string
  content: string
}

export class NoApiKeyError extends Error {}
export class UnsupportedProviderError extends Error {}

export async function callProvider(messages: ProviderMessage[]): Promise<string> {
  const config = loadCurrentProviderConfig()
  if (!config || !config.apiKey) {
    throw new NoApiKeyError('No API key configured. Open Settings to add your provider API key.')
  }

  switch (config.provider) {
    case 'google-ai-studio':
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
      return await callOpenAICompatible(config.apiKey, config.model, messages, config.baseUrl)
    default:
      throw new UnsupportedProviderError(`Provider "${config.provider}" is not supported yet.`)
  }
}

async function callOpenAICompatible(
  apiKey: string,
  model: string,
  messages: ProviderMessage[],
  baseUrl: string
): Promise<string> {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  const url = `${normalizedBaseUrl}/chat/completions`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages
    })
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`API error ${res.status}: ${errText}`)
  }

  const data = await res.json()
  const text: string = data?.choices?.[0]?.message?.content ?? '(No response received)'
  return text
}
