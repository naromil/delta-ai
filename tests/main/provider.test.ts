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
import type { ProviderMessage } from '../../src/main/provider'

const MESSAGES: ProviderMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'hi' }
]

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** OpenAI-wire stream: one content delta per text, finish_reason on the last, then [DONE]. */
function openAiFrames(texts: string[]): string[] {
  const frames = texts.map((text, index) =>
    frame({
      choices: [
        {
          index: 0,
          delta: { content: text },
          finish_reason: index === texts.length - 1 ? 'stop' : null
        }
      ]
    })
  )
  return [...frames, 'data: [DONE]\n\n']
}

function sseResponse(frames: string[], splitAt?: number): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (splitAt !== undefined) {
        const joined = frames.join('')
        controller.enqueue(encoder.encode(joined.slice(0, splitAt)))
        controller.enqueue(encoder.encode(joined.slice(splitAt)))
      } else {
        for (const item of frames) controller.enqueue(encoder.encode(item))
      }
      controller.close()
    }
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

interface Captured {
  url: string
  body: Record<string, unknown>
}

interface StubOptions {
  status?: number
  errorBody?: string
  splitAt?: number
}

function stubFetch(frames: string[], options: StubOptions = {}): Captured[] {
  const calls: Captured[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      calls.push({
        url: String(input),
        body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
          string,
          unknown
        >
      })
      if (options.status && options.status >= 400) {
        return new Response(options.errorBody ?? 'bad key', { status: options.status })
      }
      return sseResponse(frames, options.splitAt)
    })
  )
  return calls
}

async function collect(generator: AsyncGenerator<string>): Promise<string> {
  let out = ''
  for await (const chunk of generator) out += chunk
  return out
}

const openAiRole = {
  connection: { providerType: 'openai', apiKey: 'key' },
  model: 'm'
}

describe('callProviderStream', () => {
  beforeEach(() => {
    resolveRole.mockReset()
    vi.unstubAllGlobals()
  })

  it('accepts both data frame forms, skips blank and malformed frames, ends on DONE', async () => {
    resolveRole.mockReturnValue(openAiRole)
    stubFetch([
      'data:{"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
      'data:\n\n',
      'data: not-json\n\n',
      frame({ choices: [{ delta: { content: ' world!' }, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n'
    ])

    await expect(collect(callProviderStream(MESSAGES, 'chat'))).resolves.toBe('Hello world!')
  })

  it('reassembles frames split across network chunks', async () => {
    resolveRole.mockReturnValue(openAiRole)
    const joined = openAiFrames(['alpha', 'beta']).join('')
    stubFetch(openAiFrames(['alpha', 'beta']), { splitAt: joined.indexOf('"beta"') - 8 })

    await expect(collect(callProviderStream(MESSAGES, 'chat'))).resolves.toBe('alphabeta')
  })

  it('routes Google through its OpenAI-compatible endpoint', async () => {
    resolveRole.mockReturnValue({
      connection: { providerType: 'google-ai-studio', apiKey: 'test-token-d' },
      model: 'gemini-2.5-flash'
    })
    const calls = stubFetch(openAiFrames(['alpha', 'beta']))

    await expect(collect(callProviderStream(MESSAGES, 'chat'))).resolves.toBe('alphabeta')
    expect(calls[0].url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
    )
    expect(calls[0].body).toEqual({ model: 'gemini-2.5-flash', messages: MESSAGES, stream: true })
  })

  it('raises NoApiKeyError when the connection has no key', async () => {
    resolveRole.mockReturnValue({
      connection: { providerType: 'openai' },
      model: 'm'
    })

    await expect(collect(callProviderStream(MESSAGES, 'chat'))).rejects.toBeInstanceOf(
      NoApiKeyError
    )
  })

  it('raises RoleUnassignedError when the role has no connection', async () => {
    resolveRole.mockReturnValue(null)

    await expect(collect(callProviderStream(MESSAGES, 'chat'))).rejects.toThrow('unassigned:chat')
  })

  it('surfaces network failures without inventing a status code', async () => {
    resolveRole.mockReturnValue(openAiRole)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: new Error('connect ECONNREFUSED')
        })
      })
    )

    await expect(collect(callProviderStream(MESSAGES, 'chat'))).rejects.toThrow(
      /Cannot connect to API: connect ECONNREFUSED/
    )
  })

  it('surfaces non-2xx responses with the status and body', async () => {
    resolveRole.mockReturnValue(openAiRole)
    stubFetch([], { status: 401, errorBody: 'bad key' })

    await expect(collect(callProviderStream(MESSAGES, 'chat'))).rejects.toThrow(
      'API error 401: bad key'
    )
  })

  it('rejects instead of hanging when the stream ends without a finish reason', async () => {
    resolveRole.mockReturnValue(openAiRole)
    stubFetch([
      frame({ choices: [{ delta: { content: 'partial' }, finish_reason: null }] }),
      'data: [DONE]\n\n'
    ])

    await expect(collect(callProviderStream(MESSAGES, 'chat'))).rejects.toThrow(
      /Response stream ended without a finish reason/
    )
  })

  it('aborts hung requests with the 40s timeout message', async () => {
    resolveRole.mockReturnValue(openAiRole)
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: unknown, init?: RequestInit) => {
        const { promise, reject } = Promise.withResolvers<Response>()
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError'))
        )
        return promise
      })
    )

    try {
      const assertion = expect(collect(callProviderStream(MESSAGES, 'chat'))).rejects.toThrow(
        'Request timed out after 40s. Check your API endpoint and network connection.'
      )
      await vi.advanceTimersByTimeAsync(40_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out a stream that stalls after partial output', async () => {
    resolveRole.mockReturnValue(openAiRole)
    const encoder = new TextEncoder()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                frame({
                  choices: [{ delta: { content: 'partial' }, finish_reason: null }]
                })
              )
            )
            init?.signal?.addEventListener('abort', () => {
              controller.error(new DOMException('Aborted', 'AbortError'))
            })
          }
        })
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      })
    )

    vi.useFakeTimers()
    try {
      let output = ''
      const assertion = (async (): Promise<void> => {
        for await (const chunk of callProviderStream(MESSAGES, 'chat')) output += chunk
      })()
      const rejected = expect(assertion).rejects.toThrow('Request timed out after 40s.')
      await vi.advanceTimersByTimeAsync(40_000)
      await rejected
      expect(output).toBe('partial')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports cancellation instead of a timeout when the caller aborts', async () => {
    resolveRole.mockReturnValue(openAiRole)
    const controller = new AbortController()
    controller.abort()

    await expect(collect(callProviderStream(MESSAGES, 'chat', controller.signal))).rejects.toThrow(
      'Generation stopped.'
    )
  })
})

describe('callProvider', () => {
  beforeEach(() => {
    resolveRole.mockReset()
    vi.unstubAllGlobals()
  })

  it('drains the stream into one string', async () => {
    resolveRole.mockReturnValue(openAiRole)
    stubFetch(openAiFrames(['ok']))

    await expect(callProvider(MESSAGES, 'chat')).resolves.toBe('ok')
  })

  it('returns the placeholder when the stream carries no text', async () => {
    resolveRole.mockReturnValue(openAiRole)
    stubFetch([frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'])

    await expect(callProvider(MESSAGES, 'chat')).resolves.toBe('(No response received)')
  })
})
