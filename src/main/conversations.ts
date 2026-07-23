import { join } from 'path'
import { readFile, writeFile, unlink, readdir, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { app } from 'electron'
import type { ConversationRecord, ConversationMeta } from '../shared/conversation'
import { toConversationMeta } from '../shared/conversation'

function conversationsDir(): string {
  return join(app.getPath('userData'), 'conversations')
}

async function ensureConversationsDir(): Promise<void> {
  const dir = conversationsDir()
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}

export async function saveConversation(record: ConversationRecord): Promise<void> {
  await ensureConversationsDir()
  const filePath = join(conversationsDir(), `${record.id}.json`)
  await writeFile(filePath, JSON.stringify(record, null, 2), 'utf-8')
}

export async function loadConversation(id: string): Promise<ConversationRecord | null> {
  const filePath = join(conversationsDir(), `${id}.json`)
  try {
    const data = await readFile(filePath, 'utf-8')
    return JSON.parse(data) as ConversationRecord
  } catch {
    return null
  }
}

export async function deleteConversation(id: string): Promise<void> {
  const filePath = join(conversationsDir(), `${id}.json`)
  try {
    await unlink(filePath)
  } catch {
    // file didn't exist — nothing to delete
  }
}

export async function listConversations(source?: 'chat' | 'lookup'): Promise<ConversationMeta[]> {
  await ensureConversationsDir()
  const dir = conversationsDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }
  const results: ConversationMeta[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const id = file.slice(0, -5)
    const record = await loadConversation(id)
    if (!record) continue
    if (source && record.source !== source) continue
    results.push(toConversationMeta(record))
  }
  results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return results
}

export async function loadMostRecentChat(): Promise<ConversationRecord | null> {
  const metas = await listConversations('chat')
  if (metas.length === 0) return null
  return await loadConversation(metas[0].id)
}

export async function markConversationKbFed(id: string): Promise<void> {
  const record = await loadConversation(id)
  if (!record) return
  record.kbFed = true
  await saveConversation(record)
  if (record.source === 'lookup') {
    await deleteConversation(id)
  }
}

export async function listUnfedConversations(): Promise<ConversationMeta[]> {
  const all = await listConversations()
  return all.filter((m) => !m.kbFed)
}
