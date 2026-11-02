import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callProvider: vi.fn(),
  loadAppSettings: vi.fn(),
  resolveRole: vi.fn(),
  readAutoLoadedMemories: vi.fn()
}))

vi.mock('../../src/main/provider', () => ({ callProvider: mocks.callProvider }))
vi.mock('../../src/main/config', () => ({
  loadAppSettings: mocks.loadAppSettings,
  resolveRole: mocks.resolveRole
}))
vi.mock('../../src/main/memory/store', () => ({
  memoriesDir: () => '/memories',
  readAutoLoadedMemories: mocks.readAutoLoadedMemories
}))

import { suggestTermsForAnswer } from '../../src/main/suggested-terms'

const ANSWER = `A monad wraps a value. ${'Some more prose follows here. '.repeat(10)}`

describe('suggestTermsForAnswer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadAppSettings.mockReturnValue({ suggestTerms: true })
    mocks.resolveRole.mockReturnValue({ connection: {}, model: 'm' })
    mocks.readAutoLoadedMemories.mockReturnValue([{ path: 'index.md', content: 'Knows Python.' }])
    mocks.callProvider.mockResolvedValue('["monad"]')
  })

  it('asks the curator model without tools and returns the terms', async () => {
    await expect(suggestTermsForAnswer(ANSWER)).resolves.toEqual(['monad'])
    const [messages, role, , agent] = mocks.callProvider.mock.calls[0]
    expect(role).toBe('kb-maintenance')
    expect(agent).toBeUndefined()
    expect(messages[1].content).toContain('Knows Python.')
    expect(messages[1].content).toContain('A monad wraps a value.')
  })

  it.each([
    ['the setting is off', () => mocks.loadAppSettings.mockReturnValue({ suggestTerms: false })],
    ['no curator model is assigned', () => mocks.resolveRole.mockReturnValue(null)],
    ['there are no notes yet', () => mocks.readAutoLoadedMemories.mockReturnValue([])]
  ])('makes no request when %s', async (_name, arrange) => {
    arrange()
    await expect(suggestTermsForAnswer(ANSWER)).resolves.toEqual([])
    expect(mocks.callProvider).not.toHaveBeenCalled()
  })

  it('makes no request for a short answer or a malformed payload', async () => {
    await expect(suggestTermsForAnswer('Short answer.')).resolves.toEqual([])
    await expect(suggestTermsForAnswer(42)).resolves.toEqual([])
    expect(mocks.callProvider).not.toHaveBeenCalled()
  })

  it('turns a provider failure into no suggestions', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.callProvider.mockRejectedValue(new Error('rate limited'))
    await expect(suggestTermsForAnswer(ANSWER)).resolves.toEqual([])
    warn.mockRestore()
  })
})
