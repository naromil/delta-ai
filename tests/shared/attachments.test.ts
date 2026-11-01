import { describe, expect, it } from 'vitest'
import {
  MAX_IMAGE_BASE64_CHARS,
  isImageAttachment,
  isImageInput,
  scaledImageSize
} from '../../src/shared/attachments'
import { IMAGE_TOKEN_ESTIMATE, estimateMessageTokens } from '../../src/shared/context-budget'
import { serializeForChat } from '../../src/shared/conversation'
import type { Turn } from '../../src/shared/conversation'

const image = { mediaType: 'image/jpeg', data: 'QUJD' }

describe('image validation', () => {
  it('accepts a supported image', () => {
    expect(isImageInput(image)).toBe(true)
    expect(isImageAttachment({ ...image, name: 'a.jpg' })).toBe(true)
  })

  it.each([
    ['svg', { mediaType: 'image/svg+xml', data: 'QUJD' }],
    ['html', { mediaType: 'text/html', data: 'QUJD' }],
    ['a data URL', { mediaType: 'image/png', data: 'data:image/png;base64,QUJD' }],
    ['empty data', { mediaType: 'image/png', data: '' }],
    ['oversized data', { mediaType: 'image/png', data: 'A'.repeat(MAX_IMAGE_BASE64_CHARS + 1) }],
    ['null', null]
  ])('refuses %s', (_label, value) => {
    expect(isImageInput(value)).toBe(false)
  })

  it('requires a name on a stored attachment', () => {
    expect(isImageAttachment(image)).toBe(false)
  })
})

describe('scaledImageSize', () => {
  it('never upscales', () => {
    expect(scaledImageSize(100, 50)).toEqual({ width: 100, height: 50 })
  })

  it('fits the long edge and keeps the ratio', () => {
    expect(scaledImageSize(4000, 2000, 1000)).toEqual({ width: 1000, height: 500 })
    expect(scaledImageSize(2000, 4000, 1000)).toEqual({ width: 500, height: 1000 })
  })

  it('never collapses a sliver to zero', () => {
    expect(scaledImageSize(10000, 1, 1000)).toEqual({ width: 1000, height: 1 })
  })
})

describe('images in the request', () => {
  const turns: Turn[] = [
    {
      id: 1,
      role: 'user',
      content: 'what is this',
      expansions: [],
      attachments: [{ ...image, name: 'private-name.jpg' }]
    },
    { id: 2, role: 'assistant', content: 'a cat', expansions: [] },
    { id: 3, role: 'user', content: 'and now', expansions: [] }
  ]

  it('replays images with their turn, without the local file name', () => {
    const messages = serializeForChat({ turns }, 'chat')
    expect(messages[1]).toEqual({ role: 'user', content: 'what is this', images: [image] })
    expect(messages[3]).toEqual({ role: 'user', content: 'and now' })
  })

  it('counts images against the context budget', () => {
    expect(estimateMessageTokens({ role: 'user', content: '', images: [image, image] })).toBe(
      2 * IMAGE_TOKEN_ESTIMATE
    )
  })
})
