import { describe, expect, it } from 'vitest'
import { mergeKeywords, parseKeywords, trimByCategory } from '../../src/main/kb/keywords'
import { MAX_KEYWORDS_PER_CATEGORY } from '../../src/shared/models'
import type { CategorizedKeyword } from '../../src/shared/models'

const kw = (
  keyword: string,
  category: CategorizedKeyword['category'],
  count = 1
): CategorizedKeyword => ({
  keyword,
  category,
  count
})

describe('parseKeywords', () => {
  it('reads one tagged keyword per line', () => {
    const raw = [
      'Earth sciences [topic]',
      'machine learning [topic]',
      'analytical chemistry [knowledge_area]',
      'cause-and-effect [learning_preference]'
    ].join('\n')

    expect(parseKeywords(raw)).toEqual([
      kw('Earth sciences', 'topic'),
      kw('machine learning', 'topic'),
      kw('analytical chemistry', 'knowledge_area'),
      kw('cause-and-effect', 'learning_preference')
    ])
  })

  it('ignores lines without a known category tag', () => {
    expect(parseKeywords('not a keyword\nsomething [nonsense]\ntrailing [topic')).toEqual([])
  })

  it('trims surrounding whitespace and skips blank lines', () => {
    expect(parseKeywords('\n  spaced   [topic]  \n\n')).toEqual([kw('spaced', 'topic')])
  })

  it('returns nothing for empty input', () => {
    expect(parseKeywords('')).toEqual([])
  })
})

describe('mergeKeywords', () => {
  it('increments the count of an existing keyword, ignoring case', () => {
    const merged = mergeKeywords(
      [kw('Earth sciences', 'topic', 2)],
      [kw('earth sciences', 'topic')]
    )
    expect(merged).toEqual([kw('Earth sciences', 'topic', 3)])
  })

  it('keeps the same word in different categories apart', () => {
    const merged = mergeKeywords([kw('systems', 'topic')], [kw('systems', 'knowledge_area')])
    expect(merged).toEqual([kw('systems', 'topic'), kw('systems', 'knowledge_area')])
  })

  it('appends new keywords', () => {
    expect(mergeKeywords([kw('a', 'topic')], [kw('b', 'topic')])).toEqual([
      kw('a', 'topic'),
      kw('b', 'topic')
    ])
  })

  it('does not mutate its inputs', () => {
    const existing = [kw('a', 'topic', 1)]
    const incoming = [kw('a', 'topic', 1)]
    mergeKeywords(existing, incoming)
    expect(existing[0].count).toBe(1)
    expect(incoming[0].count).toBe(1)
  })
})

describe('trimByCategory', () => {
  it('caps each category and keeps the most frequent keywords', () => {
    const many = Array.from({ length: MAX_KEYWORDS_PER_CATEGORY + 5 }, (_, i) =>
      kw(`topic-${i}`, 'topic', i)
    )

    const trimmed = trimByCategory(many)

    expect(trimmed).toHaveLength(MAX_KEYWORDS_PER_CATEGORY)
    expect(trimmed[0].keyword).toBe(`topic-${MAX_KEYWORDS_PER_CATEGORY + 4}`)
    expect(trimmed.some((entry) => entry.keyword === 'topic-0')).toBe(false)
  })

  it('groups output in topic, knowledge_area, learning_preference order', () => {
    const trimmed = trimByCategory([
      kw('pref', 'learning_preference'),
      kw('area', 'knowledge_area'),
      kw('topic', 'topic')
    ])

    expect(trimmed.map((entry) => entry.category)).toEqual([
      'topic',
      'knowledge_area',
      'learning_preference'
    ])
  })

  it('leaves a small set untouched', () => {
    const input = [kw('a', 'topic'), kw('b', 'knowledge_area')]
    expect(trimByCategory(input)).toEqual(input)
  })
})
