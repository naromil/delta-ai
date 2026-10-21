import { beforeEach, describe, expect, it, vi } from 'vitest'

// provider.ts imports the Electron-backed config module; mock it so this test can
// run in plain Node while exercising the real dispatch/transport code.
const { resolveRole } = vi.hoisted(() => ({ resolveRole: vi.fn() }))

vi.mock('../../src/main/config', () => ({
  resolveRole,
  RoleUnassignedError: class RoleUnassignedError extends Error {
    constructor(roleId: string) {
      super(`unassigned:${roleId}`)
    }
  }
}))

import { callProvider, callProviderStream, NoApiKeyError } from '../../src/main/provider'

function streamResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

async function collect(generator: AsyncGenerator<string>): Promise<string> {
  let out = ''
  for await (const chunk of generator) out += chunk
  return out
}

const openAiRole = {
  connection: { providerType: 'openai', apiKey: 'key' },
  model: 'm',
  webSearchEnabled: false
}

describe('callProviderStream', () => {
  beforeEach(() => {
    resolveRole.mockReset()
    vi.unstubAllGlobals()
  })

  it('accepts both data frame forms, skips blank and malformed frames, ends on DONE', async () => {
    resolveRole.mockReturnValue(openAiRole)
    const body = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data:{"choices":[{"delta":{"content":" world"}}]}',
      'data:',
      'data: not-json',
      'data: {"choices":[{"delta":{"content":"!"}}]}',
      'data: [DONE]',
      'data: {"choices":[{"delta":{"content":"ignored"}}]}'
    ].join('\n\n')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamResponse(body))
    )

    await expect(collect(callProviderStream([], 'chat'))).resolves.toBe('Hello world!')
  })

  it('joins every Gemini candidate part', async () => {
    resolveRole.mockReturnValue({
      connection: { providerType: 'google-ai-studio', apiKey: 'key' },
      model: 'gemini',
      webSearchEnabled: true
    })
    const body = 'data: {"candidates":[{"content":{"parts":[{"text":"alpha"},{"text":"beta"}]}}]}'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamResponse(body))
    )

    await expect(collect(callProviderStream([], 'chat'))).resolves.toBe('alphabeta')
  })

  it('raises NoApiKeyError when the connection has no key', async () => {
    resolveRole.mockReturnValue({
      connection: { providerType: 'openai' },
      model: 'm',
      webSearchEnabled: false
    })

    await expect(collect(callProviderStream([], 'chat'))).rejects.toBeInstanceOf(NoApiKeyError)
  })

  it('raises RoleUnassignedError when the role has no connection', async () => {
    resolveRole.mockReturnValue(null)

    await expect(collect(callProviderStream([], 'chat'))).rejects.toThrow('unassigned:chat')
  })

  it('surfaces non-2xx responses with the status and body', async () => {
    resolveRole.mockReturnValue(openAiRole)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad key', { status: 401 }))
    )

    await expect(collect(callProviderStream([], 'chat'))).rejects.toThrow('API error 401: bad key')
  })
})

describe('callProvider', () => {
  beforeEach(() => {
    resolveRole.mockReset()
    vi.unstubAllGlobals()
  })

  it('drains the stream into one string', async () => {
    resolveRole.mockReturnValue(openAiRole)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamResponse('data: {"choices":[{"delta":{"content":"ok"}}]}'))
    )

    await expect(callProvider([], 'chat')).resolves.toBe('ok')
  })

  it('returns the placeholder for an empty stream', async () => {
    resolveRole.mockReturnValue(openAiRole)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamResponse('data: [DONE]'))
    )

    await expect(callProvider([], 'chat')).resolves.toBe('(No response received)')
  })
})
