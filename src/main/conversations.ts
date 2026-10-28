import { join } from 'path'
import { readFile, readdir, mkdir, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { app } from 'electron'
import type {
  ConversationRecord,
  ConversationMeta,
  ConversationSearchResult
} from '../shared/conversation'
import { migrateConversationRecord, toConversationMeta } from '../shared/conversation'
import { flattenMarkdown } from '../shared/rich-text'
import { writeFileAtomic } from './services/atomic-file'

/** Conversation ids are UUIDs; anything else must never reach the filesystem. */
const SAFE_CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

const RECORD_SUFFIX = '.json'
const META_SUFFIX = '.meta.json'

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
  return join(conversationsDir(), `${id}${RECORD_SUFFIX}`)
}

/** Sidecar holding the metadata for one record, next to its body. */
function conversationMetaPath(id: string): string | null {
  const filePath = conversationPath(id)
  return filePath ? `${filePath.slice(0, -RECORD_SUFFIX.length)}${META_SUFFIX}` : null
}

async function ensureConversationsDir(): Promise<void> {
  const dir = conversationsDir()
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}

async function readRecordFile(
  filePath: string,
  label?: string
): Promise<ConversationRecord | null> {
  try {
    const data = await readFile(filePath, 'utf-8')
    return JSON.parse(data) as ConversationRecord
  } catch (err) {
    if (label !== undefined) console.warn(`Failed to read conversation ${label}:`, err)
    return null
  }
}

/** Cached metadata for one record; `null` when the sidecar is missing or corrupt. */
async function readConversationMeta(id: string): Promise<ConversationMeta | null> {
  const metaPath = conversationMetaPath(id)
  if (!metaPath) return null
  let data: string
  try {
    data = await readFile(metaPath, 'utf-8')
  } catch {
    return null
  }
  try {
    return JSON.parse(data) as ConversationMeta
  } catch (err) {
    console.warn(`Failed to read conversation metadata ${id}:`, err)
    return null
  }
}

async function writeConversationMeta(record: ConversationRecord): Promise<void> {
  const metaPath = conversationMetaPath(record.id)
  if (!metaPath) return
  await writeFileAtomic(metaPath, JSON.stringify(toConversationMeta(record), null, 2))
}

async function writeConversation(
  record: ConversationRecord,
  preserveKbFed: boolean
): Promise<void> {
  const filePath = conversationPath(record.id)
  if (!filePath) return
  await ensureConversationsDir()
  // `kbFed` is owned by the KB flow in main; an auto-save from the renderer
  // must not reset it. Pass `preserveKbFed: false` from the KB writers.
  const next = preserveKbFed
    ? await readRecordFile(filePath).then((existing) =>
        existing ? { ...record, kbFed: existing.kbFed } : record
      )
    : record
  await writeFileAtomic(filePath, JSON.stringify(next, null, 2))
  await writeConversationMeta(next)
  // Notify with what actually landed on disk, so a preserved `kbFed` is not
  // mistaken for a freshly unfed conversation.
  notifyConversationSaved(next)
}

/** Per-id save chains: overlapping autosaves can never finish out of order. */
const saveChains = new Map<string, Promise<void>>()

function enqueueConversationWrite<T>(id: string, task: () => Promise<T>): Promise<T> {
  const previous = saveChains.get(id) ?? Promise.resolve()
  const run = previous.then(task, task)
  const chain = run.then(
    () => undefined,
    () => undefined
  )
  saveChains.set(id, chain)
  void chain.then(() => {
    if (saveChains.get(id) === chain) saveChains.delete(id)
  })
  return run
}

export function saveConversation(
  record: ConversationRecord,
  options?: { preserveKbFed?: boolean }
): Promise<void> {
  return enqueueConversationWrite(record.id, () =>
    writeConversation(record, options?.preserveKbFed ?? false)
  )
}

/**
 * Read-modify-write a conversation inside the same per-id chain as
 * `saveConversation`, so a mutation can never overwrite a newer autosave with
 * the body it read before that save landed. Returns `false` when the record is
 * missing or the mutation asked to cancel by returning `false`.
 */
export function mutateConversation(
  id: string,
  mutate: (record: ConversationRecord) => boolean | void
): Promise<boolean> {
  return enqueueConversationWrite(id, async () => {
    const filePath = conversationPath(id)
    if (!filePath) return false
    const record = await readRecordFile(filePath)
    if (!record) return false
    if (mutate(record) === false) return false
    await writeConversation(record, false)
    return true
  })
}

export async function loadConversation(id: string): Promise<ConversationRecord | null> {
  const filePath = conversationPath(id)
  if (!filePath) return null
  const record = await readRecordFile(filePath, id)
  return record ? migrateConversationRecord(record) : null
}

async function removeFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch {
    // file didn't exist — nothing to delete
  }
}

/** Runs in the per-id chain, so an autosave queued before the delete cannot resurrect it. */
export function deleteConversation(id: string): Promise<void> {
  return enqueueConversationWrite(id, async () => {
    const filePath = conversationPath(id)
    if (!filePath) return
    await removeFile(filePath)
    const metaPath = conversationMetaPath(id)
    if (metaPath) await removeFile(metaPath)
  })
}

async function listConversationIds(): Promise<string[]> {
  await ensureConversationsDir()
  let files: string[]
  try {
    files = await readdir(conversationsDir())
  } catch {
    return []
  }
  return files
    .filter((file) => file.endsWith(RECORD_SUFFIX) && !file.endsWith(META_SUFFIX))
    .map((file) => file.slice(0, -RECORD_SUFFIX.length))
}

async function readAllConversations(): Promise<ConversationRecord[]> {
  const ids = await listConversationIds()
  const records = await Promise.all(ids.map((id) => loadConversation(id)))
  return records.filter((record): record is ConversationRecord => record !== null)
}

/** Metadata for one record, falling back to its body and backfilling the sidecar. */
async function loadConversationMeta(id: string): Promise<ConversationMeta | null> {
  const cached = await readConversationMeta(id)
  if (cached) return cached
  const record = await loadConversation(id)
  if (!record) return null
  // Backfill inside the save chain so it cannot overwrite a newer sidecar.
  await enqueueConversationWrite(id, async () => {
    if (await readConversationMeta(id)) return
    const current = await loadConversation(id)
    if (current) await writeConversationMeta(current)
  })
  return toConversationMeta(record)
}

export async function listConversations(source?: 'chat' | 'lookup'): Promise<ConversationMeta[]> {
  const ids = await listConversationIds()
  const metas = await Promise.all(ids.map((id) => loadConversationMeta(id)))
  const results: ConversationMeta[] = []
  for (const meta of metas) {
    if (!meta) continue
    if (source && meta.source !== source) continue
    results.push(meta)
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
  const metas = await listConversations(source)
  if (!needle) {
    return metas.map((meta) => ({ ...meta, matchedIn: 'title' }))
  }

  const results: ConversationSearchResult[] = []
  const contentCandidates: ConversationMeta[] = []
  for (const meta of metas) {
    if (meta.title.toLowerCase().includes(needle)) {
      results.push({ ...meta, matchedIn: 'title' })
    } else {
      contentCandidates.push(meta)
    }
  }

  await Promise.all(
    contentCandidates.map(async (meta) => {
      const record = await loadConversation(meta.id)
      if (!record) return
      const snippet = contentSnippet(record, needle)
      if (!snippet) return
      results.push({ ...toConversationMeta(record), matchedIn: 'content', snippet })
    })
  )

  results.sort((a, b) =>
    a.matchedIn === b.matchedIn
      ? b.updatedAt.localeCompare(a.updatedAt)
      : a.matchedIn === 'title'
        ? -1
        : 1
  )
  return results.slice(0, SEARCH_RESULT_LIMIT)
}

export async function markConversationKbFed(id: string): Promise<void> {
  let lookup = false
  await mutateConversation(id, (record) => {
    if (record.source === 'lookup') {
      lookup = true
      return false
    }
    record.kbFed = true
    return true
  })
  if (lookup) await deleteConversation(id)
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
  const ids = records
    .filter((record) => record.source === 'chat' && record.kbFed)
    .map((record) => record.id)
  await Promise.all(
    ids.map((id) =>
      mutateConversation(id, (record) => {
        if (record.source !== 'chat' || !record.kbFed) return false
        record.kbFed = false
        return true
      })
    )
  )
}
