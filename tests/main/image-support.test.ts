import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IMAGE_OMITTED_NOTE } from '../../src/shared/prompts'

const h = vi.hoisted(() => ({ resolveRole: vi.fn(), getCachedModel: vi.fn() }))
vi.mock('../../src/main/config', () => ({ resolveRole: h.resolveRole }))
vi.mock('../../src/main/services/model-catalog', () => ({ getCachedModel: h.getCachedModel }))

import { fitImagesToSupport, modelImageSupport } from '../../src/main/image-support'

const image = { mediaType: 'image/jpeg', data: 'QUJD' }

describe('modelImageSupport', () => {
  beforeEach(() => {
    h.resolveRole.mockReturnValue({ connection: { providerType: 'openai' }, model: 'm' })
  })

  it.each([
    [['text', 'image'], 'yes'],
    [['text'], 'no'],
    [[], 'unknown']
  ])('reads modalities %j as %s', (inputModalities, expected) => {
    h.getCachedModel.mockReturnValue({ inputModalities })
    expect(modelImageSupport('chat')).toBe(expected)
  })

  it('is unknown for an uncatalogued model or an unassigned role', () => {
    h.getCachedModel.mockReturnValue(null)
    expect(modelImageSupport('chat')).toBe('unknown')
    h.resolveRole.mockReturnValue(null)
    expect(modelImageSupport('chat')).toBe('unknown')
  })

  it('is unknown when resolution throws', () => {
    h.resolveRole.mockImplementation(() => {
      throw new Error('boom')
    })
    expect(modelImageSupport('chat')).toBe('unknown')
  })
})

describe('fitImagesToSupport', () => {
  const withHistoryImage = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'look', images: [image] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'next' }
  ]

  it.each(['yes', 'unknown'] as const)('sends images untouched when support is %s', (support) => {
    expect(fitImagesToSupport(withHistoryImage, support)).toBe(withHistoryImage)
  })

  it('refuses images in the message being sent', () => {
    const messages = [{ role: 'user', content: 'look', images: [image] }]
    expect(fitImagesToSupport(messages, 'no')).toBeNull()
  })

  it('replaces history images with a note so the chat can continue', () => {
    const fitted = fitImagesToSupport(withHistoryImage, 'no')
    expect(fitted?.[1]).toEqual({ role: 'user', content: `look\n\n${IMAGE_OMITTED_NOTE}` })
    expect(fitted?.some((message) => message.images)).toBe(false)
  })

  it('gives an image-only history message a non-empty body', () => {
    const fitted = fitImagesToSupport(
      [
        { role: 'user', content: '', images: [image] },
        { role: 'user', content: 'next' }
      ],
      'no'
    )
    expect(fitted?.[0].content).toBe(IMAGE_OMITTED_NOTE)
  })

  it('leaves a text-only conversation alone on a text-only model', () => {
    const messages = [{ role: 'user', content: 'hi' }]
    expect(fitImagesToSupport(messages, 'no')).toBe(messages)
  })
})
