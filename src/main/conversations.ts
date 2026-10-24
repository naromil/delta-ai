import { join } from 'path'
import { readFile, readdir, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { unlink } from 'fs/promises'
import { app } from 'electron'
import type {
  ConversationRecord,
  ConversationMeta,
  ConversationSearchResult
} from '../shared/conversation'
import { flattenMarkdown, toConversationMeta } from '../shared/conversation'
import { writeFileAtomic } from './services/atomic-file'

/** Conversation ids are UUIDs; anything else must never reach the filesystem. */
const SAFE_CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

const SEARCH_SNIPPET_RADIUS = 80
const SEARCH_RESULT_LIMIT = 100

/* ---- Save notifications ---- */

type ConversationSavedListener = (record: ConversationRecord) => void

const savedListeners = new Set<ConversationSavedListener>()

/**
 * Notifies listeners after every successful write. A save is the only moment
 * new learning material appears on disk, so the Knowledge Base maintenance loop
 * subscribes here instead of polling.
 */
export function onConversationSaved(listener: ConversationSavedListener): () => void {
  savedListeners.add(listener)
  return () => {
    savedListeners.delete(listener)
  }
}

function notifyConversationSaved(record: ConversationRecord): void {
  for (const listener of savedListeners) {
    try {
      listener(record)
    } catch (err) {
      console.warn('Conversation save listener failed:', err)
    }
  }
}

function conversationsDir(): string {
  return join(app.getPath('userData'), 'conversations')
}

function conversationPath(id: string): string | null {
  if (!SAFE_CONVERSATION_ID.test(id)) {
    console.warn(`Refusing unsafe conversation id: ${JSON.stringify(id)}`)
    return null
  }
  return join(conversationsDir(), `${id}.json`)
}

async function ensureConversationsDir(): Promise<void> {
  const dir = conversationsDir()
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}

export async function saveConversation(record: ConversationRecord): Promise<void> {
  const filePath = conversationPath(record.id)
  if (!filePath) return
  await ensureConversationsDir()
  await writeFileAtomic(filePath, JSON.stringify(record, null, 2))
  notifyConversationSaved(record)
}

export async function loadConversation(id: string): Promise<ConversationRecord | null> {
  const filePath = conversationPath(id)
  if (!filePath) return null
  try {
    const data = await readFile(filePath, 'utf-8')
    return JSON.parse(data) as ConversationRecord
  } catch (err) {
    console.warn(`Failed to read conversation ${id}:`, err)
    return null
  }
}

export async function deleteConversation(id: string): Promise<void> {
  const filePath = conversationPath(id)
  if (!filePath) return
  try {
    await unlink(filePath)
  } catch {
    // file didn't exist — nothing to delete
  }
}

async function readAllConversations(): Promise<ConversationRecord[]> {
  await ensureConversationsDir()
  let files: string[]
  try {
    files = await readdir(conversationsDir())
  } catch {
    return []
  }
  const ids = files.filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5))
  const records = await Promise.all(ids.map((id) => loadConversation(id)))
  return records.filter((record): record is ConversationRecord => record !== null)
}

export async function listConversations(source?: 'chat' | 'lookup'): Promise<ConversationMeta[]> {
  const records = await readAllConversations()
  const results: ConversationMeta[] = []
  for (const record of records) {
    if (source && record.source !== source) continue
    results.push(toConversationMeta(record))
  }
  results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return results
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SEARCH_SNIPPET_RADIUS)
  const end = Math.min(text.length, index + length + SEARCH_SNIPPET_RADIUS)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

function contentSnippet(record: ConversationRecord, needle: string): string | undefined {
  for (let i = record.state.turns.length - 1; i >= 0; i--) {
    const turn = record.state.turns[i]
    const text = flattenMarkdown(turn.content).replace(/\s+/g, ' ').trim()
    const index = text.toLowerCase().indexOf(needle)
    if (index >= 0) return excerptAround(text, index, needle.length)
  }
  return undefined
}

/**
 * Searches chat conversations by title and message content. Title matches rank
 * before content matches; within a group the newest conversation comes first.
 */
export async function searchConversations(
  query: string,
  source: 'chat' | 'lookup' = 'chat'
): Promise<ConversationSearchResult[]> {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return (await listConversations(source)).map((meta) => ({ ...meta, matchedIn: 'title' }))
  }

  const records = await readAllConversations()
  const results: ConversationSearchResult[] = []
  for (const record of records) {
    if (record.source !== source) continue
    const titleMatch = record.title.toLowerCase().includes(needle)
    const snippet = titleMatch ? undefined : contentSnippet(record, needle)
    if (!titleMatch && !snippet) continue
    results.push({
      ...toConversationMeta(record),
      matchedIn: titleMatch ? 'title' : 'content',
      ...(snippet ? { snippet } : {})
    })
  }

  results.sort((a, b) =>
    a.matchedIn === b.matchedIn
      ? b.updatedAt.localeCompare(a.updatedAt)
      : a.matchedIn === 'title'
        ? -1
        : 1
  )
  return results.slice(0, SEARCH_RESULT_LIMIT)
}

export async function loadMostRecentChat(): Promise<ConversationRecord | null> {
  const metas = await listConversations('chat')
  if (metas.length === 0) return null
  return await loadConversation(metas[0].id)
}

export async function markConversationKbFed(id: string): Promise<void> {
  const record = await loadConversation(id)
  if (!record) return
  if (record.source === 'lookup') {
    await deleteConversation(id)
    return
  }
  record.kbFed = true
  await saveConversation(record)
}

export async function listUnfedConversations(): Promise<ConversationMeta[]> {
  const all = await listConversations()
  return all.filter((m) => !m.kbFed)
}

/**
 * Make every chat conversation eligible for analysis again. Called when the KB
 * is reset so "Analyze" can rebuild the prompt from existing history instead of
 * finding nothing because every record is still flagged as fed.
 */
export async function resetKbFedFlags(): Promise<void> {
  const records = await readAllConversations()
  const chats = records.filter((record) => record.source === 'chat' && record.kbFed)
  await Promise.all(
    chats.map((record) => {
      record.kbFed = false
      return saveConversation(record)
    })
  )
}
