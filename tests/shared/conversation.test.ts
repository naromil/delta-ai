import { describe, expect, it } from 'vitest'
import type { ConversationRecord, ExpansionNode, Turn } from '../../src/shared/conversation'
import {
  linearRecordOf,
  linearStateOf,
  buildConversationTitle,
  migrateConversationRecord,
  persistableTurns,
  serializeForChat
} from '../../src/shared/conversation'
import { DELTA_SYSTEM_PROMPT, getSystemPrompt, LOOKUP_WINDOW_NOTE } from '../../src/shared/prompts'

function turn(overrides: Partial<Turn> & Pick<Turn, 'id' | 'role' | 'content'>): Turn {
  return { expansions: [], ...overrides }
}

const expansion = (id: number, overrides: Partial<ExpansionNode> = {}): ExpansionNode => ({
  id,
  start: 0,
  end: 4,
  originalText: 'term',
  answer: '',
  status: 'done',
  folded: false,
  children: [],
  ...overrides
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
  const turns = [turn({ id: 1, role: 'user', content: 'hello' })]

  it('uses the chat prompt and no context preamble without context', () => {
    expect(serializeForChat({ turns })).toEqual([
      { role: 'system', content: DELTA_SYSTEM_PROMPT },
      { role: 'user', content: 'hello' }
    ])
  })

  it('injects the screen context before the turns', () => {
    const messages = serializeForChat({ context: 'screen', turns })
    expect(messages[0]).toEqual({ role: 'system', content: DELTA_SYSTEM_PROMPT })
    expect(messages[1].content).toContain('screen')
    expect(messages[2]).toEqual({ role: 'user', content: 'hello' })
  })

  it('gives lookup the same assistant as chat, plus a note about its small window', () => {
    expect(getSystemPrompt('lookup')).toBe(`${DELTA_SYSTEM_PROMPT} ${LOOKUP_WINDOW_NOTE}`)
    expect(getSystemPrompt('chat')).toBe(DELTA_SYSTEM_PROMPT)
  })

  it('omits the preamble for a lookup with no captured context', () => {
    const messages = serializeForChat({ turns }, 'lookup')
    expect(messages).toEqual([
      { role: 'system', content: getSystemPrompt('lookup') },
      { role: 'user', content: 'hello' }
    ])
  })

  it('omits failed assistant turns so an error string is never replayed as an answer', () => {
    const messages = serializeForChat({
      turns: [
        turn({ id: 1, role: 'user', content: 'hello' }),
        turn({ id: 2, role: 'assistant', content: 'API error 401: bad key', error: true }),
        turn({ id: 3, role: 'user', content: 'try again' })
      ]
    })

    expect(messages).toEqual([
      { role: 'system', content: DELTA_SYSTEM_PROMPT },
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'try again' }
    ])
  })

  it('omits empty assistant placeholders from legacy records', () => {
    const messages = serializeForChat({
      turns: [
        turn({ id: 1, role: 'user', content: 'hello' }),
        turn({ id: 2, role: 'assistant', content: '   ' }),
        turn({ id: 3, role: 'user', content: 'try again' })
      ]
    })

    expect(messages).toEqual([
      { role: 'system', content: DELTA_SYSTEM_PROMPT },
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'try again' }
    ])
  })

  it('never sends expansion answers as model context', () => {
    const messages = serializeForChat({
      turns: [
        turn({
          id: 1,
          role: 'assistant',
          content: 'alpha beta',
          expansions: [expansion(1, { answer: 'secret explanation', children: [] })]
        })
      ]
    })
    expect(messages).toHaveLength(2)
    expect(messages[1].content).toBe('alpha beta')
  })
})

describe('persistableTurns', () => {
  it('drops empty assistant placeholders but keeps user and failed turns', () => {
    const turns = [
      turn({ id: 1, role: 'user', content: 'hello' }),
      turn({ id: 2, role: 'assistant', content: '   ' }),
      turn({ id: 3, role: 'user', content: 'again' }),
      turn({ id: 4, role: 'assistant', content: 'API error 401', error: true })
    ]

    expect(persistableTurns(turns).map((item) => item.id)).toEqual([1, 3, 4])
  })

  it('keeps a completed assistant turn', () => {
    const turns = [
      turn({ id: 1, role: 'user', content: 'hello' }),
      turn({ id: 2, role: 'assistant', content: 'hi there' })
    ]

    expect(persistableTurns(turns)).toEqual(turns)
  })
})

describe('migrateConversationRecord', () => {
  it('fills expansions for turns that never had them', () => {
    const record: ConversationRecord = {
      id: 'c1',
      title: 't',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
      source: 'chat',
      kbFed: false,
      state: {
        turns: [{ id: 1, role: 'user', content: 'hello' } as unknown as Turn]
      }
    }

    const migrated = migrateConversationRecord(record)
    expect(migrated.state.turns[0].expansions).toEqual([])
    expect(migrated.state.turns[0].content).toBe('hello')
  })

  const stored = (extra: object): ConversationRecord =>
    ({
      id: 'c1',
      title: 't',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
      kbFed: true,
      ...extra
    }) as unknown as ConversationRecord
  const turns = [{ id: 1, role: 'user', content: 'hello', expansions: [] }]

  it('moves a stored look-up context into the look-up properties', () => {
    const migrated = migrateConversationRecord(
      stored({ source: 'lookup', state: { context: 'screen', systemNote: '', turns } })
    )
    expect(migrated).toEqual({
      id: 'c1',
      title: 't',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
      kbFed: true,
      source: 'lookup',
      state: { turns },
      lookup: { context: 'screen' }
    })
  })

  it('moves a stored layout into the canvas properties', () => {
    const canvas = { cards: [], frames: [], links: [], viewport: { x: 1, y: 2, zoom: 1 } }
    const migrated = migrateConversationRecord(
      stored({ source: 'canvas', state: { turns, canvas } })
    )
    expect(migrated).toMatchObject({ source: 'canvas', state: { turns }, canvas })
    expect(migrated.state).not.toHaveProperty('canvas')
  })

  it('gives a canvas that never stored a layout an empty one', () => {
    const migrated = migrateConversationRecord(stored({ source: 'canvas', state: { turns } }))
    expect(migrated.source === 'canvas' && migrated.canvas.cards).toEqual([])
  })

  it('keeps screen text an old chat holds, as its first message', () => {
    const migrated = migrateConversationRecord(
      stored({ source: 'chat', state: { context: 'screen', turns } })
    )
    expect(migrated.state.turns).toHaveLength(2)
    expect(migrated.state.turns[0].role).toBe('user')
    expect(migrated.state.turns[0].id).not.toBe(1)
    expect(migrated.state.turns[0].content).toContain('screen')
    expect(migrated.state).not.toHaveProperty('context')
  })

  it('drops what belongs to another type and leaves a current record as it is', () => {
    const lookup = migrateConversationRecord(
      stored({ source: 'lookup', state: { turns }, lookup: { context: 'x' }, canvas: {} })
    )
    expect(lookup).not.toHaveProperty('canvas')
    expect(migrateConversationRecord(lookup)).toEqual(lookup)
  })
})

describe('linear records', () => {
  const meta = {
    id: 'c1',
    title: 't',
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    kbFed: false
  }
  const turns: Turn[] = [{ id: 1, role: 'user', content: 'hello', expansions: [] }]

  it('round-trips a look-up through the state the chat hook holds', () => {
    const record = linearRecordOf({ ...meta, source: 'lookup' }, { context: 'screen', turns })
    expect(record).toEqual({
      ...meta,
      source: 'lookup',
      state: { turns },
      lookup: { context: 'screen' }
    })
    expect(linearStateOf(record)).toEqual({ context: 'screen', turns })
  })

  it('stores no screen text on a chat', () => {
    const record = linearRecordOf({ ...meta, source: 'chat' }, { context: 'screen', turns })
    expect(record).toEqual({ ...meta, source: 'chat', state: { turns } })
    expect(linearStateOf(record)).toEqual({ context: '', turns })
  })
})
