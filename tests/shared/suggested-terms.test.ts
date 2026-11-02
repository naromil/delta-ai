import { describe, expect, it } from 'vitest'
import { MAX_SUGGESTED_TERMS, parseSuggestedTerms } from '../../src/shared/suggested-terms'

const ANSWER = 'A monad wraps a value, and functors map over one.'

describe('parseSuggestedTerms', () => {
  it('reads a JSON array, even inside a code fence or next to prose', () => {
    expect(parseSuggestedTerms('["monad"]', ANSWER)).toEqual(['monad'])
    expect(parseSuggestedTerms('```json\n["monad", "functors"]\n```', ANSWER)).toEqual([
      'monad',
      'functors'
    ])
    expect(parseSuggestedTerms('Here: ["monad"] done', ANSWER)).toEqual(['monad'])
  })

  it('returns nothing for a reply it cannot read', () => {
    expect(parseSuggestedTerms('(No response received)', ANSWER)).toEqual([])
    expect(parseSuggestedTerms('[not json]', ANSWER)).toEqual([])
    expect(parseSuggestedTerms('', ANSWER)).toEqual([])
  })

  it('keeps only strings that occur in the answer, once each', () => {
    expect(
      parseSuggestedTerms('["monad", "MONAD", 3, null, "", "absent", "  wraps  "]', ANSWER)
    ).toEqual(['monad', 'wraps'])
  })

  it('caps the count and drops an oversized term', () => {
    const answer = 'a b c d e f g ' + 'x'.repeat(100)
    const reply = JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'x'.repeat(100)])
    const terms = parseSuggestedTerms(reply, answer)
    expect(terms).toHaveLength(MAX_SUGGESTED_TERMS)
    expect(terms).not.toContain('x'.repeat(100))
  })
})
