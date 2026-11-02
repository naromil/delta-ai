import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveRole, getCachedModel, paths, windows, send } = vi.hoisted(() => {
  const send = vi.fn()
  return {
    resolveRole: vi.fn(),
    getCachedModel: vi.fn(),
    paths: { userData: '' },
    send,
    windows: [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }]
  }
})

vi.mock('electron', () => ({
  app: { getPath: (): string => paths.userData },
  BrowserWindow: { getAllWindows: () => windows }
}))
vi.mock('../../src/main/config', () => ({
  resolveRole,
  RoleUnassignedError: class RoleUnassignedError extends Error {}
}))
vi.mock('../../src/main/services/model-catalog', () => ({ getCachedModel }))

import { memoriesDir } from '../../src/main/memory/store'
import { memoryAgentFor } from '../../src/main/memory/tools'
import { KB_MEMORY_SYSTEM_PROMPT } from '../../src/shared/prompts'
import { callProvider, callProviderStream } from '../../src/main/provider'
import type { ProviderMessage } from '../../src/main/provider'
import type { RoleId } from '../../src/shared/models'

const MESSAGES: ProviderMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'I am a chemist' }
]
const WRITE_TOOLS = ['memory_write', 'memory_edit', 'memory_mkdir', 'memory_mv', 'memory_rm']

interface ToolCall {
  name: string
  args: unknown
}

function sse(frames: unknown[]): Response {
  const body = [...frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`), 'data: [DONE]\n\n']
  return new Response(body.join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  })
}

function textReply(text: string): Response {
  return sse([{ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] }])
}

function toolReply(calls: ToolCall[], text?: string): Response {
  const tool_calls = calls.map(({ name, args }, index) => ({
    index,
    id: `call_${index}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  }))
  return sse([
    ...(text ? [{ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }] : []),
    { choices: [{ index: 0, delta: { tool_calls }, finish_reason: 'tool_calls' }] }
  ])
}

type RequestBody = {
  tools?: Array<{ function: { name: string } }>
  tool_choice?: unknown
  messages: Array<{ role: string; content: unknown }>
}

function stubFetch(replies: Array<() => Response>): RequestBody[] {
  const bodies: RequestBody[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init?.body)) as RequestBody)
      const reply = replies[Math.min(bodies.length - 1, replies.length - 1)]
      return reply()
    })
  )
  return bodies
}

function memoryFile(relative: string): string {
  return readFileSync(join(paths.userData, 'memories', relative), 'utf-8')
}

function toolNames(body: RequestBody): string[] {
  return (body.tools ?? []).map((entry) => entry.function.name)
}

function agentFor(role: RoleId): NonNullable<ReturnType<typeof memoryAgentFor>> {
  const agent = memoryAgentFor(role)
  if (!agent) throw new Error('expected memory tools')
  return agent
}

beforeEach(() => {
  paths.userData = mkdtempSync(join(tmpdir(), 'delta-memory-tools-'))
  resolveRole.mockReset()
  resolveRole.mockReturnValue({ connection: { providerType: 'openai', apiKey: 'k' }, model: 'm' })
  getCachedModel.mockReset()
  getCachedModel.mockReturnValue(null)
  send.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rmSync(paths.userData, { recursive: true, force: true })
})

describe('memoryAgentFor', () => {
  it('gives chat the full tool set and describes the current layout', async () => {
    const agent = agentFor('chat')
    const bodies = stubFetch([() => textReply('ok')])
    await callProvider(MESSAGES, 'chat', undefined, agent)
    expect(toolNames(bodies[0])).toEqual(expect.arrayContaining(WRITE_TOOLS))
    expect(JSON.stringify(bodies[0].messages[0])).toContain('(empty)')
  })

  it('lets every role write, but only the curator is told to do the routine upkeep', () => {
    for (const role of ['chat', 'lookup', 'kb-maintenance'] as const) {
      expect(Object.keys(agentFor(role).tools)).toEqual(expect.arrayContaining(WRITE_TOOLS))
    }
    expect(agentFor('chat').instructions).toMatch(/background curator/)
    expect(agentFor('lookup').instructions).toMatch(/background curator/)
    expect(agentFor('kb-maintenance').instructions).not.toMatch(/background curator/)
    expect(agentFor('kb-maintenance').maxSteps).toBeGreaterThan(agentFor('chat').maxSteps)
  })

  it('loads learning preferences into every prompt and has the curator maintain them', () => {
    writeFileSync(join(memoriesDir(), 'index-learning.md'), 'Prefers worked examples.')
    for (const role of ['chat', 'lookup', 'kb-maintenance'] as const) {
      expect(agentFor(role).instructions).toContain('Prefers worked examples.')
    }
    expect(KB_MEMORY_SYSTEM_PROMPT).toContain('index-learning.md')
  })

  it('encourages index and collection meta-files', () => {
    expect(agentFor('chat').instructions).toMatch(/index\.md/)
    expect(agentFor('kb-maintenance').instructions).toMatch(/collection files/)
  })

  it('withholds tools from a model the catalog says cannot call them', () => {
    getCachedModel.mockReturnValue({ toolCall: false })
    expect(memoryAgentFor('chat')).toBeUndefined()
    getCachedModel.mockReturnValue({ toolCall: true })
    expect(memoryAgentFor('chat')).toBeDefined()
  })

  it('never throws when the catalog or config does', () => {
    resolveRole.mockImplementation(() => {
      throw new Error('boom')
    })
    expect(memoryAgentFor('chat')).toBeUndefined()
  })
})

describe('auto-loaded files', () => {
  function memories(): string {
    return join(paths.userData, 'memories')
  }

  it('is included in every prompt without a tool call', () => {
    mkdirSync(memories(), { recursive: true })
    writeFileSync(join(memories(), 'index.md'), 'User is a chemist. See work/.')
    for (const role of ['chat', 'lookup', 'kb-maintenance'] as const) {
      expect(agentFor(role).instructions).toContain('User is a chemist. See work/.')
    }
  })

  it('loads only root files whose name starts with index', () => {
    mkdirSync(join(memories(), 'work'), { recursive: true })
    writeFileSync(join(memories(), 'index-learning.md'), 'ROOT-PREFIXED')
    writeFileSync(join(memories(), 'work', 'index.md'), 'NESTED-INDEX')
    writeFileSync(join(memories(), 'profile.md'), 'UNPREFIXED')
    const { instructions } = agentFor('chat')
    expect(instructions).toContain('ROOT-PREFIXED')
    expect(instructions).not.toContain('NESTED-INDEX')
    expect(instructions).not.toContain('UNPREFIXED')
    // The rest of the tree stays discoverable by path.
    expect(instructions).toContain('work/index.md')
    expect(instructions).toContain('profile.md')
  })

  it('states the auto-loading rule to every writer', () => {
    for (const role of ['chat', 'lookup', 'kb-maintenance'] as const) {
      expect(agentFor(role).instructions).toMatch(
        /Auto-loading rule: .*root directory.*starts with "index"/
      )
    }
  })

  it('caps the total across root files', () => {
    for (const name of ['index-a.md', 'index-b.md', 'index-c.md']) {
      writeFileSync(join(memoriesDir(), name), 'z'.repeat(7_000))
    }
    const { instructions } = agentFor('chat')
    expect(instructions).toContain('truncated; read the file')
    expect(instructions.match(/z/g)?.length ?? 0).toBeLessThan(16_200)
  })

  it('reads as missing until one exists', () => {
    expect(agentFor('chat').instructions).toContain('(none exist yet)')
  })

  it('is capped, so a huge index cannot crowd out the conversation', () => {
    mkdirSync(memories(), { recursive: true })
    writeFileSync(join(memories(), 'index.md'), 'x'.repeat(20_000))
    const { instructions } = agentFor('chat')
    expect(instructions).toContain('truncated; read the file')
    expect(instructions.length).toBeLessThan(15_000)
  })

  it('does not take the tools down when it is a symlink', () => {
    mkdirSync(memories(), { recursive: true })
    const outside = join(paths.userData, 'outside.md')
    writeFileSync(outside, 'SECRET')
    symlinkSync(outside, join(memories(), 'index.md'))
    const { instructions } = agentFor('chat')
    expect(instructions).not.toContain('SECRET')
    expect(instructions).toContain('(none exist yet)')
  })
})

describe('memory-updated', () => {
  it('fires for writes that succeed, not for reads or refusals', async () => {
    const agent = agentFor('kb-maintenance')
    stubFetch([
      () =>
        toolReply([
          { name: 'memory_ls', args: { path: '.' } },
          { name: 'memory_write', args: { path: '../escape.md', content: 'x' } }
        ]),
      () => textReply('nothing')
    ])
    await callProvider(MESSAGES, 'kb-maintenance', undefined, agent)
    expect(send).not.toHaveBeenCalled()

    stubFetch([
      () => toolReply([{ name: 'memory_write', args: { path: 'a.md', content: 'x' } }]),
      () => textReply('wrote')
    ])
    await callProvider(MESSAGES, 'kb-maintenance', undefined, agent)
    expect(send).toHaveBeenCalledWith('memory-updated')
  })

  it('does not fail the write when a window cannot be told', async () => {
    send.mockImplementation(() => {
      throw new Error('renderer gone')
    })
    const agent = agentFor('chat')
    const bodies = stubFetch([
      () => toolReply([{ name: 'memory_write', args: { path: 'a.md', content: 'x' } }]),
      () => textReply('ok')
    ])
    await callProvider(MESSAGES, 'chat', undefined, agent)
    expect(memoryFile('a.md')).toBe('x')
    expect(JSON.stringify(bodies[1].messages)).toContain('Wrote a.md')
  })
})

describe('agent loop', () => {
  it('runs tool calls on disk, feeds results back, then answers', async () => {
    const agent = agentFor('chat')
    const bodies = stubFetch([
      () =>
        toolReply([
          { name: 'memory_write', args: { path: 'work/job.md', content: 'Chemist' } },
          { name: 'memory_cat', args: { path: 'work/job.md' } }
        ]),
      () => textReply('Noted.')
    ])
    const answer = await callProvider(MESSAGES, 'chat', undefined, agent)
    expect(answer).toBe('Noted.')
    expect(memoryFile('work/job.md')).toBe('Chemist')
    const results = bodies[1].messages.filter((message) => message.role === 'tool')
    expect(JSON.stringify(results)).toContain('Wrote work/job.md')
    expect(JSON.stringify(results)).toContain('Chemist')
  })

  it('returns refusals to the model instead of failing the message', async () => {
    const agent = agentFor('chat')
    const bodies = stubFetch([
      () => toolReply([{ name: 'memory_cat', args: { path: '../../providers.json' } }]),
      () => textReply('Could not read that.')
    ])
    expect(await callProvider(MESSAGES, 'chat', undefined, agent)).toBe('Could not read that.')
    const results = JSON.stringify(bodies[1].messages.filter((m) => m.role === 'tool'))
    expect(results).toContain('not allowed')
    expect(results).not.toContain(paths.userData)
  })

  it('keeps text from separate steps apart', async () => {
    const agent = agentFor('chat')
    stubFetch([
      () => toolReply([{ name: 'memory_ls', args: { path: '.' } }], 'Let me check.'),
      () => textReply('Nothing yet.')
    ])
    let streamed = ''
    for await (const chunk of callProviderStream(MESSAGES, 'chat', undefined, agent)) {
      streamed += chunk
    }
    expect(streamed).toBe('Let me check.\n\nNothing yet.')
  })

  it('forces a text answer on the last step so a looping model still replies', async () => {
    const agent = agentFor('chat')
    let calls = 0
    const bodies = stubFetch([
      () => {
        calls += 1
        return calls < 10
          ? toolReply([{ name: 'memory_ls', args: { path: '.' } }])
          : textReply('Done.')
      }
    ])
    expect(await callProvider(MESSAGES, 'chat', undefined, agent)).toBe('Done.')
    expect(bodies).toHaveLength(10)
    expect(bodies[9].tool_choice).toBe('none')
  })
})

describe('tool rejection', () => {
  it('fails a curator pass instead of retrying without tools', async () => {
    const agent = agentFor('kb-maintenance')
    const bodies = stubFetch([() => new Response('model does not support tools', { status: 400 })])
    await expect(callProvider(MESSAGES, 'kb-maintenance', undefined, agent)).rejects.toThrow(
      'API error 400'
    )
    expect(bodies).toHaveLength(1)
  })

  it('retries a rejected request once without tools or their instructions', async () => {
    const agent = agentFor('chat')
    const bodies = stubFetch([
      () => new Response('model does not support tools', { status: 400 }),
      () => textReply('plain answer')
    ])
    expect(await callProvider(MESSAGES, 'chat', undefined, agent)).toBe('plain answer')
    expect(bodies).toHaveLength(2)
    expect(bodies[1].tools).toBeUndefined()
    expect(JSON.stringify(bodies[1].messages)).not.toContain('memory_')
  })

  it('reports the error when the plain retry also fails, without looping', async () => {
    const agent = agentFor('chat')
    const bodies = stubFetch([() => new Response('bad request', { status: 400 })])
    await expect(callProvider(MESSAGES, 'chat', undefined, agent)).rejects.toThrow(
      'API error 400: bad request'
    )
    expect(bodies).toHaveLength(2)
  })

  it('does not retry an auth failure', async () => {
    const agent = agentFor('chat')
    const bodies = stubFetch([() => new Response('bad key', { status: 401 })])
    await expect(callProvider(MESSAGES, 'chat', undefined, agent)).rejects.toThrow('API error 401')
    expect(bodies).toHaveLength(1)
  })
})
