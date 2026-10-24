import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationRecord } from '../../src/shared/conversation'

const paths = vi.hoisted(() => ({ userData: '' }))
const writes = vi.hoisted(() => [] as string[])

vi.mock('electron', () => ({
  app: { getPath: (): string => paths.userData }
}))

vi.mock('../../src/main/services/atomic-file', () => ({
  writeFileAtomic: async (_path: string, data: string): Promise<void> => {
    const title = (JSON.parse(data) as { title: string }).title
    writes.push(`start:${title}`)
    await new Promise((resolve) => setTimeout(resolve, 15))
    writes.push(`end:${title}`)
  }
}))

import { saveConversation } from '../../src/main/conversations'

function record(title: string): ConversationRecord {
  return {
    id: 'queue_a',
    title,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    source: 'chat',
    state: {
      turns: [{ id: 1, role: 'user', content: title, expansions: [] }]
    },
    kbFed: false
  }
}

describe('saveConversation queue', () => {
  beforeEach(() => {
    paths.userData = mkdtempSync(join(tmpdir(), 'delta-ai-queue-'))
    writes.length = 0
  })

  afterEach(() => {
    rmSync(paths.userData, { recursive: true, force: true })
  })

  it('serialises overlapping saves for the same id, last payload winning', async () => {
    await Promise.all([saveConversation(record('first')), saveConversation(record('second'))])

    expect(writes).toEqual(['start:first', 'end:first', 'start:second', 'end:second'])
  })
})
