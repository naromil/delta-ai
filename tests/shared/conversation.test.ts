import { describe, expect, it } from 'vitest'
import type { ExpandableSegment } from '../../src/shared/conversation'
import {
  buildConversationTitle,
  findExpansionInSegments,
  findTextSelectionRange,
  flattenMarkdown,
  insertExpansion,
  insertExpansionNested,
  maxExpansionId,
  persistableTurns,
  serializeForChat,
  toggleExpansionFoldedInTurns,
  tokenize,
  updateExpansionInTurns
} from '../../src/shared/conversation'
import { CHAT_SYSTEM_PROMPT, LOOKUP_SYSTEM_PROMPT } from '../../src/shared/prompts'

const text = (value: string): ExpandableSegment => ({ kind: 'text', text: value })

const expansion = (
  id: number,
  overrides: Partial<Extract<ExpandableSegment, { kind: 'expansion' }>> = {}
): ExpandableSegment => ({
  kind: 'expansion',
  expansionId: id,
  originalText: `term${id}`,
  cachedText: `cached${id}`,
  folded: false,
  segments: [],
  ...overrides
})

/** What `insertExpansion` creates: empty, loading, unfurled. */
const freshExpansion = (
  id: number,
  overrides: Partial<Extract<ExpandableSegment, { kind: 'expansion' }>> = {}
): ExpandableSegment => ({
  kind: 'expansion',
  expansionId: id,
  originalText: `term${id}`,
  cachedText: '',
  prompt: undefined,
  loading: true,
  folded: false,
  segments: [],
  ...overrides
})

describe('flattenMarkdown', () => {
  it('strips headings, emphasis, code and links', () => {
    expect(flattenMarkdown('# Title\n\nSome **bold**, _italic_ and `code` [link](http://x).')).toBe(
      'Title\n\nSome bold, italic and code link.'
    )
  })

  it('rewrites list markers and blockquotes', () => {
    expect(flattenMarkdown('- one\n* two\n1. three\n> quote')).toBe('· one\n· two\n· three\nquote')
  })

  it('drops horizontal rules', () => {
    expect(flattenMarkdown('a\n\n---\n\nb').replace(/\n+/g, '|')).toBe('a|b')
  })
})

describe('tokenize', () => {
  it('returns no segments for empty input', () => {
    expect(tokenize('')).toEqual([])
  })

  it('keeps newline runs attached to the preceding text segment', () => {
    expect(tokenize('first\n\nsecond')).toEqual([text('first\n\n'), text('second')])
  })

  it('flattens markdown before splitting', () => {
    expect(tokenize('**bold**')).toEqual([text('bold')])
  })
})

describe('insertExpansion', () => {
  it('replaces a whole segment', () => {
    const result = insertExpansion([text('a'), text('b')], 0, 1, 'a', 7)
    expect(result.startIndex).toBe(0)
    expect(result.segments).toHaveLength(2)
    expect(result.segments[0].kind).toBe('expansion')
    expect(result.segments[1]).toEqual(text('b'))
  })

  it('splits a single segment around a character range', () => {
    const result = insertExpansion([text('Hello world')], 0, 1, 'world', 1, 6, 11)
    expect(result.startIndex).toBe(1)
    expect(result.segments).toEqual([text('Hello '), freshExpansion(1, { originalText: 'world' })])
  })

  it('splits the first and last segment and consumes the middle of a multi-segment range', () => {
    const result = insertExpansion([text('aa'), text('bb'), text('cc')], 0, 3, 'abbc', 2, 1, 1)
    expect(result.startIndex).toBe(1)
    expect(result.segments).toEqual([
      text('a'),
      freshExpansion(2, { originalText: 'abbc' }),
      text('c')
    ])
  })

  it('refuses an empty or out-of-bounds range', () => {
    expect(insertExpansion([text('abc')], 0, 0, 'a', 2)).toEqual({
      segments: [text('abc')],
      startIndex: -1
    })
    expect(insertExpansion([text('abc')], 0, 2, 'a', 2)).toEqual({
      segments: [text('abc')],
      startIndex: -1
    })
    expect(insertExpansion([text('abc')], 0, 1, 'a', 2, 2, 2)).toEqual({
      segments: [text('abc')],
      startIndex: -1
    })
  })

  it('refuses a range that crosses an expansion boundary', () => {
    const input = [expansion(1), text('x')]
    const result = insertExpansion(input, 0, 1, 'term1', 2)
    expect(result.startIndex).toBe(-1)
    expect(result.segments).toBe(input)
  })
})

describe('insertExpansionNested', () => {
  it('inserts into a nested expansion when a parent id is given', () => {
    const input = [expansion(1, { segments: [text('inner text')] })]
    const result = insertExpansionNested(input, 1, 0, 1, 'inner', 9)
    expect(result.inserted).toBe(true)
    const parent = result.segments[0] as Extract<ExpandableSegment, { kind: 'expansion' }>
    expect(parent.segments?.[0].kind).toBe('expansion')
  })

  it('falls back to the top level without a parent id', () => {
    const result = insertExpansionNested([text('a'), text('b')], undefined, 0, 1, 'a', 3)
    expect(result.inserted).toBe(true)
    expect(result.segments[0].kind).toBe('expansion')
  })

  it('reports no insertion when the parent id is missing', () => {
    const input = [text('a'), text('b')]
    const result = insertExpansionNested(input, 42, 0, 1, 'a', 3)
    expect(result.inserted).toBe(false)
    expect(result.segments).toBe(input)
  })
})

describe('findTextSelectionRange', () => {
  it('uses the exact-match fast path', () => {
    expect(findTextSelectionRange([text('  fox  ')], 'fox', 0)).toEqual({
      startIdx: 0,
      endIdx: 1
    })
  })

  it('finds a selection spanning two segments and reports offsets', () => {
    expect(
      findTextSelectionRange([text('The quick '), text('brown fox')], 'quick brown', 0)
    ).toEqual({ startIdx: 0, endIdx: 2, startOffset: 4, endOffset: 5 })
  })

  it('returns -1 when the anchor segment is an expansion', () => {
    expect(findTextSelectionRange([expansion(1)], 'term', 0)).toEqual({
      startIdx: -1,
      endIdx: -1
    })
  })

  it('returns -1 when no occurrence covers the anchor', () => {
    expect(findTextSelectionRange([text('foo'), text('bar'), text('baz')], 'baz', 0)).toEqual({
      startIdx: -1,
      endIdx: -1
    })
  })

  it('returns -1 for an out-of-range anchor', () => {
    expect(findTextSelectionRange([text('foo')], 'foo', 4)).toEqual({
      startIdx: -1,
      endIdx: -1
    })
  })
})

describe('expansion tree updates', () => {
  const turns = [
    { id: 1, role: 'user' as const, content: 'hi' },
    {
      id: 2,
      role: 'assistant' as const,
      content: 'answer',
      segments: [expansion(5, { segments: [expansion(6)] })]
    }
  ]

  it('patches an expansion at any depth', () => {
    const patched = updateExpansionInTurns(turns, 6, { cachedText: 'deep' })
    const parent = patched[1].segments?.[0] as Extract<ExpandableSegment, { kind: 'expansion' }>
    const child = parent.segments?.[0] as Extract<ExpandableSegment, { kind: 'expansion' }>
    expect(child.cachedText).toBe('deep')
  })

  it('toggles folded at any depth', () => {
    const folded = toggleExpansionFoldedInTurns(turns, 6, true)
    const parent = folded[1].segments?.[0] as Extract<ExpandableSegment, { kind: 'expansion' }>
    const child = parent.segments?.[0] as Extract<ExpandableSegment, { kind: 'expansion' }>
    expect(child.folded).toBe(true)
  })
})

describe('findExpansionInSegments', () => {
  it('finds a top-level expansion', () => {
    const found = findExpansionInSegments([expansion(1)], 1)
    expect(found?.cachedText).toBe('cached1')
  })

  it('finds nested expansions', () => {
    const segments = [expansion(1, { segments: [expansion(2)] })]
    expect(findExpansionInSegments(segments, 2)?.expansionId).toBe(2)
  })

  it('returns null when the id is absent', () => {
    expect(findExpansionInSegments([expansion(1)], 99)).toBeNull()
  })
})

describe('maxExpansionId', () => {
  it('returns the highest id across turns and nesting levels', () => {
    const turns = [
      { id: 1, role: 'user' as const, content: 'hi' },
      { id: 2, role: 'assistant' as const, content: 'a', segments: [expansion(4)] },
      {
        id: 3,
        role: 'assistant' as const,
        content: 'b',
        segments: [expansion(2, { segments: [expansion(9)] })]
      }
    ]
    expect(maxExpansionId(turns)).toBe(9)
  })

  it('returns 0 for a conversation without expansions', () => {
    expect(maxExpansionId([])).toBe(0)
  })
})

describe('buildConversationTitle', () => {
  it('flattens markdown and collapses whitespace', () => {
    expect(buildConversationTitle('# **Hello**   world\n\nagain')).toBe('Hello world again')
  })

  it('truncates long titles at the word boundary cap', () => {
    const title = buildConversationTitle('x'.repeat(120))
    expect(title).toHaveLength(60)
  })

  it('falls back for blank input', () => {
    expect(buildConversationTitle('   \n ')).toBe('New conversation')
  })
})

describe('serializeForChat', () => {
  const turns = [{ id: 1, role: 'user' as const, content: 'hello' }]

  it('uses the chat prompt and no context preamble without context', () => {
    expect(serializeForChat({ turns })).toEqual([
      { role: 'system', content: CHAT_SYSTEM_PROMPT },
      { role: 'user', content: 'hello' }
    ])
  })

  it('injects the screen context before the turns', () => {
    const messages = serializeForChat({ context: 'screen', turns })
    expect(messages[0]).toEqual({ role: 'system', content: CHAT_SYSTEM_PROMPT })
    expect(messages[1].content).toContain('screen')
    expect(messages[2]).toEqual({ role: 'user', content: 'hello' })
  })

  it('always uses the lookup prompt for the lookup role', () => {
    const messages = serializeForChat({ turns }, 'lookup')
    expect(messages[0]).toEqual({ role: 'system', content: LOOKUP_SYSTEM_PROMPT })
  })

  it('omits failed assistant turns so an error string is never replayed as an answer', () => {
    const messages = serializeForChat({
      turns: [
        { id: 1, role: 'user', content: 'hello' },
        { id: 2, role: 'assistant', content: 'API error 401: bad key', error: true },
        { id: 3, role: 'user', content: 'try again' }
      ]
    })

    expect(messages).toEqual([
      { role: 'system', content: CHAT_SYSTEM_PROMPT },
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'try again' }
    ])
  })

  it('omits empty assistant placeholders from legacy records', () => {
    const messages = serializeForChat({
      turns: [
        { id: 1, role: 'user', content: 'hello' },
        { id: 2, role: 'assistant', content: '   ' },
        { id: 3, role: 'user', content: 'try again' }
      ]
    })

    expect(messages).toEqual([
      { role: 'system', content: CHAT_SYSTEM_PROMPT },
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'try again' }
    ])
  })
})

describe('persistableTurns', () => {
  it('drops empty assistant placeholders but keeps user and failed turns', () => {
    const turns = [
      { id: 1, role: 'user' as const, content: 'hello' },
      { id: 2, role: 'assistant' as const, content: '   ' },
      { id: 3, role: 'user' as const, content: 'again' },
      { id: 4, role: 'assistant' as const, content: 'API error 401', error: true }
    ]

    expect(persistableTurns(turns).map((turn) => turn.id)).toEqual([1, 3, 4])
  })

  it('keeps a completed assistant turn', () => {
    const turns = [
      { id: 1, role: 'user' as const, content: 'hello' },
      { id: 2, role: 'assistant' as const, content: 'hi there' }
    ]

    expect(persistableTurns(turns)).toEqual(turns)
  })
})
