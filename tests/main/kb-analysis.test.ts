import { describe, expect, it } from 'vitest'
import type { ConversationRecord } from '../../src/shared/conversation'
import { migrateConversationRecord } from '../../src/shared/conversation'
import type { LegacyTurn } from '../../src/shared/rich-text'
import { buildSingleMaterial } from '../../src/main/kb/analysis'

function legacyRecord(turns: LegacyTurn[]): ConversationRecord {
  return {
    id: 'kb1',
    title: 'KB',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    source: 'chat',
    state: { turns },
    kbFed: false
  } as unknown as ConversationRecord
}

describe('buildSingleMaterial', () => {
  it('reads migrated expansion fields, including nested answers', () => {
    const record = migrateConversationRecord(
      legacyRecord([
        {
          id: 1,
          role: 'assistant',
          content: 'ignored',
          segments: [
            { kind: 'text', text: 'Alpha ' },
            {
              kind: 'expansion',
              expansionId: 1,
              originalText: 'beta',
              cachedText: 'discarded when children exist',
              prompt: 'more',
              folded: false,
              segments: [
                { kind: 'text', text: 'beta ' },
                {
                  kind: 'expansion',
                  expansionId: 2,
                  originalText: 'one',
                  cachedText: 'child answer',
                  folded: false,
                  segments: []
                }
              ]
            }
          ]
        }
      ])
    )

    const material = buildSingleMaterial(record)

    expect(material).toContain('Expanded terms:')
    expect(material).toContain('- Context: Alpha beta')
    expect(material).toContain('  Term: "beta"')
    expect(material).toContain('  Answer: beta one')
    expect(material).toContain('  Prompt: "more"')
    expect(material).toContain('  Term: "one"')
    expect(material).toContain('  Answer: child answer')
  })

  it('omits the expansion section when no turn has expansions', () => {
    const record = migrateConversationRecord(
      legacyRecord([
        { id: 1, role: 'user', content: 'what is X' },
        { id: 2, role: 'assistant', content: 'X is Y' }
      ])
    )

    const material = buildSingleMaterial(record)

    expect(material).toContain('Questions:')
    expect(material).toContain('  User: what is X')
    expect(material).not.toContain('Expanded terms:')
  })

  it('truncates a long expansion answer to 300 characters', () => {
    const long = 'x'.repeat(350)
    const record = migrateConversationRecord(
      legacyRecord([
        {
          id: 1,
          role: 'assistant',
          content: '',
          segments: [
            { kind: 'text', text: 'Term ' },
            {
              kind: 'expansion',
              expansionId: 1,
              originalText: 'term',
              cachedText: long,
              folded: false,
              segments: []
            }
          ]
        }
      ])
    )

    const material = buildSingleMaterial(record)
    expect(material).toContain('  Answer: ' + 'x'.repeat(300) + '...')
    expect(material).not.toContain('x'.repeat(301))
  })
})
