import { describe, expect, it } from 'vitest'
import type { ExpansionNode } from '../../src/shared/rich-text'
import type { LegacySegment } from '../../src/shared/rich-text'
import {
  EXPANSION_EMPTY_ERROR,
  EXPANSION_INTERRUPTED_ERROR,
  applyExpansionChunk,
  crossesBlockBoundary,
  expansionMessageInput,
  finalizeTurns,
  findExpansionInNodes,
  findExpansionInTurns,
  flattenMarkdown,
  insertExpansion,
  insertExpansionInTurns,
  maxExpansionId,
  migrateLegacySegments,
  migrateLegacyTurn,
  plainTextOf,
  removeExpansionInTurns,
  setExpansionFolded,
  updateExpansion,
  validateExpansionTarget,
  validateInsertion
} from '../../src/shared/rich-text'

interface TestTurn {
  id: number
  role: 'user' | 'assistant'
  content: string
  expansions: ExpansionNode[]
}

function turn(overrides: Partial<TestTurn> & Pick<TestTurn, 'id' | 'content'>): TestTurn {
  return { role: 'assistant', expansions: [], ...overrides }
}

function node(id: number, overrides: Partial<ExpansionNode> = {}): ExpansionNode {
  return {
    id,
    start: 0,
    end: 4,
    originalText: 'term',
    answer: '',
    status: 'done',
    folded: false,
    children: [],
    ...overrides
  }
}

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

describe('validateInsertion', () => {
  it('accepts a range inside an emphasis span', () => {
    const source = 'Try **alpha beta** here'
    const start = source.indexOf('alpha')
    expect(validateInsertion(source, [], { start, end: start + 5 })).toBeNull()
  })

  it('accepts a range inside a list item', () => {
    const source = '- first item\n- second item'
    const start = source.indexOf('second')
    expect(validateInsertion(source, [], { start, end: start + 6 })).toBeNull()
  })

  it('rejects an empty range', () => {
    expect(validateInsertion('abc', [], { start: 1, end: 1 })).toBe('empty-range')
  })

  it('rejects a whitespace-only range', () => {
    expect(validateInsertion('a b', [], { start: 1, end: 2 })).toBe('blank-selection')
  })

  it('rejects out-of-bounds ranges', () => {
    expect(validateInsertion('abc', [], { start: -1, end: 2 })).toBe('out-of-bounds')
    expect(validateInsertion('abc', [], { start: 0, end: 4 })).toBe('out-of-bounds')
    expect(validateInsertion('abc', [], { start: 2, end: 1 })).toBe('out-of-bounds')
  })

  it('rejects a range that crosses a block boundary', () => {
    const source = 'first paragraph\n\nsecond paragraph'
    const start = source.indexOf('paragraph')
    const end = source.indexOf('second') + 'second'.length
    expect(validateInsertion(source, [], { start, end })).toBe('cross-block')
  })

  it('rejects a range spanning two list items', () => {
    const source = '- one\n- two'
    const start = source.indexOf('one')
    const end = source.indexOf('two') + 3
    expect(validateInsertion(source, [], { start, end })).toBe('cross-block')
  })

  it('allows a range across a soft line break inside one paragraph', () => {
    const source = 'first line\nsecond line'
    const start = source.indexOf('line')
    const end = source.indexOf('second') + 6
    expect(validateInsertion(source, [], { start, end })).toBeNull()
  })

  it('detects block boundaries lexically', () => {
    expect(crossesBlockBoundary('a\n\nb', 0, 4)).toBe(true)
    expect(crossesBlockBoundary('a\nb', 0, 3)).toBe(false)
    expect(crossesBlockBoundary('a\n# heading', 0, 11)).toBe(true)
  })
})

describe('insertExpansion', () => {
  it('anchors a range inside bold text at absolute source offsets', () => {
    const source = 'Try **alpha beta** here'
    const start = source.indexOf('alpha')
    const result = insertExpansion(source, [], { start, end: start + 5 }, 1)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.node).toMatchObject({
      id: 1,
      start,
      end: start + 5,
      originalText: 'alpha',
      answer: '',
      status: 'loading',
      folded: false,
      children: []
    })
    expect(result.expansions).toHaveLength(1)
  })

  it('anchors a range inside a list item', () => {
    const source = '- first item\n- second item'
    const start = source.indexOf('second')
    const result = insertExpansion(source, [], { start, end: start + 6 }, 2)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.node.originalText).toBe('second')
    expect(source.slice(result.node.start, result.node.end)).toBe('second')
  })

  it('refuses an overlapping range', () => {
    const source = 'alpha beta gamma'
    const first = insertExpansion(source, [], { start: 0, end: 5 }, 1)
    if (!first.ok) throw new Error('expected insertion')
    expect(insertExpansion(source, first.expansions, { start: 3, end: 10 }, 2)).toEqual({
      ok: false,
      reason: 'overlaps-expansion'
    })
  })

  it('refuses a range inside an existing expansion', () => {
    const source = 'alpha beta gamma'
    const first = insertExpansion(source, [], { start: 0, end: 5 }, 1)
    if (!first.ok) throw new Error('expected insertion')
    expect(insertExpansion(source, first.expansions, { start: 1, end: 4 }, 2)).toEqual({
      ok: false,
      reason: 'inside-expansion'
    })
  })

  it('keeps sibling expansions ordered by source offset', () => {
    const source = 'one two three'
    const second = insertExpansion(source, [], { start: 8, end: 13 }, 2)
    if (!second.ok) throw new Error('expected insertion')
    const first = insertExpansion(source, second.expansions, { start: 0, end: 3 }, 1)
    if (!first.ok) throw new Error('expected insertion')
    expect(first.expansions.map((item) => item.id)).toEqual([1, 2])
  })
})

describe('insertExpansionInTurns', () => {
  it('inserts into a parent answer using offsets relative to that answer', () => {
    const turns = [turn({ id: 1, content: 'alpha beta', expansions: [] })]
    const top = insertExpansionInTurns(turns, 1, { start: 0, end: 5 }, 1)
    if (!top.ok) throw new Error('expected insertion')

    const withAnswer = updateExpansion(top.turns, 1, {
      answer: 'beta gamma delta',
      status: 'done'
    })
    // 5..10 is inside the parent answer but past the end of the turn content.
    const nested = insertExpansionInTurns(
      withAnswer,
      1,
      { start: 5, end: 10, parentExpansionId: 1 },
      2
    )
    expect(nested.ok).toBe(true)
    if (!nested.ok) return

    const parent = nested.turns[0].expansions[0]
    expect(parent.answer).toBe('beta gamma delta')
    expect(parent.children).toHaveLength(1)
    expect(parent.children[0]).toMatchObject({
      id: 2,
      start: 5,
      end: 10,
      originalText: 'gamma',
      children: []
    })
  })

  it('reports a missing turn or parent', () => {
    const turns = [turn({ id: 1, content: 'alpha' })]
    expect(insertExpansionInTurns(turns, 99, { start: 0, end: 5 }, 2)).toEqual({
      ok: false,
      reason: 'turn-not-found'
    })
    expect(
      insertExpansionInTurns(turns, 1, { start: 0, end: 5, parentExpansionId: 42 }, 2)
    ).toEqual({ ok: false, reason: 'parent-not-found' })
  })

  it('refuses invalid ranges at the turn level', () => {
    const turns = [turn({ id: 1, content: 'alpha beta' })]
    expect(insertExpansionInTurns(turns, 1, { start: 3, end: 3 }, 2)).toEqual({
      ok: false,
      reason: 'empty-range'
    })
  })
})

describe('fold/unfold and updates', () => {
  const turns = [
    turn({
      id: 1,
      content: 'outer',
      expansions: [node(1, { start: 0, end: 5, children: [node(2, { start: 0, end: 4 })] })]
    })
  ]

  it('folds an expansion at any depth', () => {
    const folded = setExpansionFolded(turns, 2, true)
    expect(folded[0].expansions[0].children[0].folded).toBe(true)
    expect(setExpansionFolded(folded, 2, true)).toBe(folded)
  })

  it('unfolds an expansion at any depth', () => {
    const folded = setExpansionFolded(turns, 2, true)
    const unfolded = setExpansionFolded(folded, 2, false)
    expect(unfolded[0].expansions[0].children[0].folded).toBe(false)
  })

  it('applies non-structural patches', () => {
    const updated = updateExpansion(turns, 2, { answer: 'streamed', status: 'error', error: 'x' })
    expect(updated[0].expansions[0].children[0]).toMatchObject({
      answer: 'streamed',
      status: 'error',
      error: 'x',
      start: 0,
      end: 4
    })
  })

  it('returns the same array when the patch changes nothing', () => {
    expect(updateExpansion(turns, 1, { folded: false })).toBe(turns)
    expect(updateExpansion(turns, 99, { folded: true })).toBe(turns)
  })
})

describe('find and max id', () => {
  const turns = [
    turn({
      id: 1,
      content: 'x',
      expansions: [node(4, { children: [node(9, { children: [node(12)] })] })]
    })
  ]

  it('finds a nested node with its parent and siblings', () => {
    const found = findExpansionInNodes(turns[0].expansions, 9)
    expect(found?.node.id).toBe(9)
    expect(found?.parent?.id).toBe(4)
    expect(found?.siblings.map((item) => item.id)).toEqual([9])
  })

  it('finds a top-level node', () => {
    const found = findExpansionInNodes(turns[0].expansions, 4)
    expect(found?.node.id).toBe(4)
    expect(found?.parent).toBeNull()
    expect(found?.siblings.map((item) => item.id)).toEqual([4])
  })

  it('finds inside turns and reports the owning turn', () => {
    const found = findExpansionInTurns(turns, 12)
    expect(found?.node.id).toBe(12)
    expect(found?.turn.id).toBe(1)
    expect(found?.parent?.id).toBe(9)
  })

  it('returns null for an absent id', () => {
    expect(findExpansionInNodes(turns[0].expansions, 99)).toBeNull()
    expect(findExpansionInTurns(turns, 99)).toBeNull()
  })

  it('returns the highest id across nesting levels', () => {
    expect(maxExpansionId(turns)).toBe(12)
    expect(maxExpansionId([])).toBe(0)
  })
})

describe('expansionMessageInput', () => {
  const turns = [
    turn({
      id: 1,
      content: 'alpha beta',
      expansions: [node(1, { start: 0, end: 5, answer: 'beta gamma delta' })]
    })
  ]

  it('uses the turn content at the top level', () => {
    expect(expansionMessageInput(turns[0], undefined, { start: 6, end: 10 })).toEqual({
      answer: 'alpha beta',
      selection: 'beta'
    })
  })

  it('uses the parent answer for a nested target', () => {
    expect(expansionMessageInput(turns[0], 1, { start: 5, end: 10 })).toEqual({
      answer: 'beta gamma delta',
      selection: 'gamma'
    })
  })

  it('rejects unknown parents and bad ranges', () => {
    expect(expansionMessageInput(turns[0], 42, { start: 0, end: 1 })).toBeNull()
    expect(expansionMessageInput(turns[0], undefined, { start: 0, end: 99 })).toBeNull()
    expect(expansionMessageInput(turns[0], undefined, { start: 4, end: 4 })).toBeNull()
  })
})

describe('plainTextOf', () => {
  it('flattens markdown when there are no expansions', () => {
    expect(plainTextOf('Some **bold** and `code`', [])).toBe('Some bold and code')
  })

  it('keeps the expanded term in place', () => {
    const content = 'Some **bold** text'
    const start = content.indexOf('bold')
    const expansions = [node(1, { start, end: start + 4, originalText: 'bold' })]
    expect(plainTextOf(content, expansions)).toBe('Some bold text')
  })

  it('falls back to the stored term when the range no longer matches', () => {
    const content = 'Some bold text'
    const start = content.indexOf('bold')
    const expansions = [node(1, { start, end: start + 4, originalText: 'BOLD' })]
    expect(plainTextOf(content, expansions)).toBe('Some BOLD text')
  })
})

describe('selection equality', () => {
  it('accepts a target whose covered slice matches the selected text', () => {
    const source = 'alpha beta'
    expect(validateExpansionTarget(source, [], { start: 0, end: 5, selection: 'alpha' })).toBeNull()
  })

  it('accepts a selection inside emphasis: the slice is the rendered text', () => {
    const source = 'Try **bold** here'
    const start = source.indexOf('bold')
    expect(source.slice(start, start + 4)).toBe('bold')
    expect(
      validateExpansionTarget(source, [], { start, end: start + 4, selection: 'bold' })
    ).toBeNull()
  })

  it('keeps leading and trailing whitespace in lockstep with the DOM selection', () => {
    const source = 'x beta y'
    const start = source.indexOf(' beta ')
    const end = start + ' beta '.length
    expect(validateExpansionTarget(source, [], { start, end, selection: ' beta ' })).toBeNull()
  })

  it('refuses a selection that spans an inline boundary', () => {
    const source = '**a** b'
    const start = source.indexOf('a')
    const end = source.length
    // The DOM selection is "a b"; the source slice still contains the markers,
    // and the renderer's text-node check refuses it before insertion.
    expect(validateExpansionTarget(source, [], { start, end, selection: 'a b' })).toBe(
      'selection-mismatch'
    )
  })

  it('refuses a snapshot whose offsets no longer cover the selected text', () => {
    const source = 'alpha beta'
    expect(validateExpansionTarget(source, [], { start: 0, end: 5, selection: 'gamma' })).toBe(
      'selection-mismatch'
    )
    expect(insertExpansion(source, [], { start: 0, end: 5, selection: 'x' }, 1)).toEqual({
      ok: false,
      reason: 'selection-mismatch'
    })
  })
})

describe('applyExpansionChunk', () => {
  const turns = [
    turn({
      id: 1,
      content: 'outer',
      expansions: [
        node(1, {
          start: 0,
          end: 5,
          status: 'loading',
          children: [node(2, { start: 0, end: 4 })]
        })
      ]
    })
  ]

  it('appends text to the answer only and keeps children intact', () => {
    const next = applyExpansionChunk(turns, 1, { text: 'streamed' })
    const parent = next[0].expansions[0]
    expect(parent.answer).toBe('streamed')
    // Still streaming: status is only terminal after `done`.
    expect(parent.status).toBe('loading')
    expect(parent.children).toBe(turns[0].expansions[0].children)
    expect(parent.children).toHaveLength(1)
  })

  it('sets done on completion with output', () => {
    let next = applyExpansionChunk(turns, 1, { text: 'final' })
    next = applyExpansionChunk(next, 1, { text: 'final', done: true })
    expect(next[0].expansions[0].status).toBe('done')
    expect(next[0].expansions[0].answer).toBe('final')
    expect(next[0].expansions[0].children).toHaveLength(1)
  })

  it('turns an empty completion into an explicit error', () => {
    const next = applyExpansionChunk(turns, 1, { text: '', done: true })
    expect(next[0].expansions[0].status).toBe('error')
    expect(next[0].expansions[0].error).toBe(EXPANSION_EMPTY_ERROR)
  })

  it('records a stream error but keeps the partial answer', () => {
    const withText = applyExpansionChunk(turns, 1, { text: 'partial' })
    const next = applyExpansionChunk(withText, 1, { error: 'boom' })
    expect(next[0].expansions[0].status).toBe('error')
    expect(next[0].expansions[0].error).toBe('boom')
    expect(next[0].expansions[0].answer).toBe('partial')
  })

  it('ignores chunks for unknown ids', () => {
    expect(applyExpansionChunk(turns, 99, { text: 'x' })).toBe(turns)
  })
})

describe('finalizeTurns', () => {
  it('converts transient loading nodes into recoverable errors', () => {
    const turns = [
      turn({
        id: 1,
        content: 'x',
        expansions: [
          node(1, { status: 'loading', answer: '', children: [] }),
          node(2, { status: 'loading', answer: 'partial', children: [] }),
          node(3, { status: 'done' })
        ]
      })
    ]

    const next = finalizeTurns(turns)
    expect(next[0].expansions[0]).toMatchObject({
      status: 'error',
      error: EXPANSION_EMPTY_ERROR
    })
    expect(next[0].expansions[1]).toMatchObject({
      status: 'error',
      error: EXPANSION_INTERRUPTED_ERROR
    })
    expect(next[0].expansions[2].status).toBe('done')
  })

  it('returns the same array when nothing is transient', () => {
    const turns = [turn({ id: 1, content: 'x', expansions: [node(1)] })]
    expect(finalizeTurns(turns)).toBe(turns)
  })
})

describe('removeExpansionInTurns', () => {
  it('removes one node and keeps the rest', () => {
    const turns = [
      turn({
        id: 1,
        content: 'x',
        expansions: [node(1, { children: [node(2)] }), node(3)]
      })
    ]
    const next = removeExpansionInTurns(turns, 2)
    expect(next[0].expansions[0].children).toEqual([])
    expect(next[0].expansions[1].id).toBe(3)
  })

  it('returns the same array for an absent id', () => {
    const turns = [turn({ id: 1, content: 'x', expansions: [node(1)] })]
    expect(removeExpansionInTurns(turns, 99)).toBe(turns)
  })
})

describe('duplicate ids', () => {
  it('updates only the first match', () => {
    const turns = [turn({ id: 1, content: 'x', expansions: [node(7), node(7)] })]
    const next = updateExpansion(turns, 7, { answer: 'first' })
    expect(next[0].expansions[0].answer).toBe('first')
    expect(next[0].expansions[1].answer).toBe('')
  })
})

describe('migrateLegacySegments', () => {
  const nestedLegacy: LegacySegment[] = [
    { kind: 'text', text: 'Alpha ' },
    {
      kind: 'expansion',
      expansionId: 3,
      originalText: 'beta',
      cachedText: 'beta one',
      folded: true,
      segments: [
        { kind: 'text', text: 'beta ' },
        {
          kind: 'expansion',
          expansionId: 4,
          originalText: 'one',
          cachedText: 'first',
          folded: false,
          segments: []
        }
      ]
    }
  ]

  it('rebuilds content and offsets, including a nested tree', () => {
    const { content, expansions } = migrateLegacySegments(nestedLegacy)
    expect(content).toBe('Alpha beta')

    expect(expansions).toHaveLength(1)
    const parent = expansions[0]
    expect(parent).toMatchObject({
      id: 3,
      start: 6,
      end: 10,
      originalText: 'beta',
      answer: 'beta one',
      folded: true
    })

    expect(parent.children).toHaveLength(1)
    expect(parent.children[0]).toMatchObject({
      id: 4,
      start: 5,
      end: 8,
      originalText: 'one',
      answer: 'first',
      status: 'done'
    })
  })

  it('marks errored and in-flight legacy expansions', () => {
    const { expansions } = migrateLegacySegments([
      {
        kind: 'expansion',
        expansionId: 1,
        originalText: 'x',
        cachedText: 'partial',
        error: 'API error',
        folded: false,
        segments: []
      },
      {
        kind: 'expansion',
        expansionId: 2,
        originalText: 'y',
        cachedText: '',
        loading: true,
        folded: false,
        segments: []
      }
    ])

    expect(expansions[0].status).toBe('error')
    expect(expansions[0].error).toBe('API error')
    expect(expansions[1].status).toBe('loading')
  })

  it('keeps markdown content untouched for turns without expansions', () => {
    const migrated = migrateLegacyTurn({
      id: 1,
      role: 'assistant',
      content: '**bold** answer',
      segments: [{ kind: 'text', text: 'bold answer' }]
    })
    expect(migrated.content).toBe('**bold** answer')
    expect(migrated.expansions).toEqual([])
    expect('segments' in migrated).toBe(false)
  })

  it('rebuilds turns that carry expansions', () => {
    const migrated = migrateLegacyTurn({
      id: 1,
      role: 'assistant',
      content: '**beta** answer',
      segments: [
        { kind: 'text', text: 'beta' },
        {
          kind: 'expansion',
          expansionId: 5,
          originalText: 'beta',
          cachedText: 'definition',
          folded: false,
          segments: [{ kind: 'text', text: 'definition' }]
        }
      ]
    })
    expect(migrated.content).toBe('betabeta')
    expect(migrated.expansions[0].start).toBe(4)
    expect(migrated.expansions[0].end).toBe(8)
    // The dead legacy tree must not be persisted again.
    expect('segments' in migrated).toBe(false)
  })

  it('leaves already-migrated turns alone', () => {
    const existing = turn({ id: 1, content: 'x', expansions: [node(1)] })
    expect(migrateLegacyTurn(existing).expansions).toBe(existing.expansions)
  })
})
