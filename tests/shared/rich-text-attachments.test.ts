import { describe, expect, it } from 'vitest'
import type { ExpansionNode } from '../../src/shared/rich-text'
import {
  insertExpansionInTurns,
  restartExpansion,
  updateExpansion
} from '../../src/shared/rich-text'

const IMAGE = { name: 'a.jpg', mediaType: 'image/jpeg', data: 'AAAA' }
const TURN = { id: 1, content: 'alpha beta', expansions: [] as ExpansionNode[] }

function inserted(): (typeof TURN)[] {
  const result = insertExpansionInTurns([TURN], 1, { start: 0, end: 5 }, 7, 'Why?', [IMAGE])
  if (!result.ok) throw new Error(result.reason)
  return result.turns
}

describe('an expansion as a question', () => {
  it('stores the images asked with it', () => {
    expect(inserted()[0].expansions[0].attachments).toEqual([IMAGE])
  })

  it('stores no attachments field when there are none', () => {
    const result = insertExpansionInTurns([TURN], 1, { start: 0, end: 5 }, 7, 'Why?', [])
    expect(result.ok && 'attachments' in result.turns[0].expansions[0]).toBe(false)
  })

  it('keeps its images and takes the new question when edited', () => {
    const edited = restartExpansion(updateExpansion(inserted(), 7, { prompt: 'How?' }), 7)
    const node = edited[0].expansions[0]
    expect(node).toMatchObject({ prompt: 'How?', attachments: [IMAGE], status: 'loading' })
    expect(node.answer).toBe('')
  })

  it('can drop its question and return to the plain instruction', () => {
    const edited = updateExpansion(inserted(), 7, { prompt: undefined })
    expect(edited[0].expansions[0].prompt).toBeUndefined()
  })
})
