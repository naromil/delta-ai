import type { ProviderMessage } from './models'
import { getSystemPrompt, buildScreenContextMessage } from './prompts'

export type { ProviderMessage }

export type ExpandableSegment =
  | { kind: 'text'; text: string }
  | {
      kind: 'expansion'
      expansionId: number
      originalText: string
      cachedText: string
      prompt?: string
      error?: string
      loading?: boolean
      folded: boolean
      segments: ExpandableSegment[]
    }

export type ExpansionSegment = Extract<ExpandableSegment, { kind: 'expansion' }>

export interface Turn {
  id: number
  role: 'user' | 'assistant'
  content: string
  segments?: ExpandableSegment[]
  error?: boolean
}

export interface ConversationState {
  context?: string
  systemNote?: string
  turns: Turn[]
}

export interface ConversationRecord {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  source: 'chat' | 'lookup'
  state: ConversationState
  kbFed: boolean
}

export interface ConversationMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  source: 'chat' | 'lookup'
  kbFed: boolean
  turnCount: number
}

export function toConversationMeta(record: ConversationRecord): ConversationMeta {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    source: record.source,
    kbFed: record.kbFed,
    turnCount: record.state.turns.length
  }
}

export function flattenMarkdown(text: string): string {
  text = text.replace(/^#{1,6}\s+/gm, '')
  text = text.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
  text = text.replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
  text = text.replace(/`([^`]+)`/g, '$1')
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  text = text.replace(/^[\s]*[-*+]\s+/gm, '\u00b7 ')
  text = text.replace(/^[\s]*\d+\.\s+/gm, '\u00b7 ')
  text = text.replace(/^>\s+/gm, '')
  text = text.replace(/^[-*_]{3,}\s*$/gm, '')
  return text
}

export function tokenize(text: string): ExpandableSegment[] {
  const flattened = flattenMarkdown(text)
  const segments: ExpandableSegment[] = []
  const parts = flattened.split(/(\n+)/)
  for (const part of parts) {
    if (part === '') continue
    if (/^\n+$/.test(part) && segments.length > 0) {
      const last = segments[segments.length - 1]
      if (last.kind === 'text') {
        last.text += part
        continue
      }
    }
    segments.push({ kind: 'text', text: part })
  }
  return segments
}

export function insertExpansion(
  segments: ExpandableSegment[],
  startIndex: number,
  endIndex: number,
  selection: string,
  newExpansionId: number,
  startOffset?: number,
  endOffset?: number,
  prompt?: string
): { segments: ExpandableSegment[]; startIndex: number } {
  // Refuse if any segment in [startIndex, endIndex) is an expansion boundary
  for (let i = startIndex; i < endIndex; i++) {
    if (segments[i]?.kind === 'expansion') {
      return { segments, startIndex: -1 }
    }
  }

  const head = segments.slice(0, startIndex)
  const tail = segments.slice(endIndex)

  const expansion: ExpandableSegment = {
    kind: 'expansion',
    expansionId: newExpansionId,
    originalText: selection,
    cachedText: '',
    prompt,
    loading: true,
    folded: false,
    segments: []
  }

  if (startOffset !== undefined || endOffset !== undefined) {
    const firstSeg = segments[startIndex] as { kind: 'text'; text: string }
    const actualStartOffset = startOffset ?? 0
    const actualEndOffset =
      endIndex - startIndex === 1
        ? (endOffset ?? firstSeg.text.length)
        : (endOffset ?? (segments[endIndex - 1] as { kind: 'text'; text: string }).text.length)

    if (endIndex - startIndex === 1) {
      const before = firstSeg.text.slice(0, actualStartOffset)
      const after = firstSeg.text.slice(actualEndOffset)
      const parts: ExpandableSegment[] = []
      if (before !== '') parts.push({ kind: 'text', text: before })
      parts.push(expansion)
      if (after !== '') parts.push({ kind: 'text', text: after })
      const newStartIndex = head.length + (before !== '' ? 1 : 0)
      return { segments: [...head, ...parts, ...tail], startIndex: newStartIndex }
    }

    // Multi-segment: split first and last, consume middle
    const lastSeg = segments[endIndex - 1] as { kind: 'text'; text: string }
    const middle = segments.slice(startIndex + 1, endIndex - 1)
    const before = firstSeg.text.slice(0, actualStartOffset)
    const after = lastSeg.text.slice(actualEndOffset)
    const parts: ExpandableSegment[] = []
    if (before !== '') parts.push({ kind: 'text', text: before })
    parts.push(expansion)
    for (const m of middle) parts.push(m)
    if (after !== '') parts.push({ kind: 'text', text: after })
    const newStartIndex = head.length + (before !== '' ? 1 : 0)
    return { segments: [...head, ...parts, ...tail], startIndex: newStartIndex }
  }

  return { segments: [...head, expansion, ...tail], startIndex }
}

/**
 * Insert an expansion into a nested segments tree.
 * When parentExpansionId is provided, recursively finds that expansion
 * and inserts into its child segments; otherwise works at the top level.
 */
export function insertExpansionNested(
  segments: ExpandableSegment[],
  parentExpansionId: number | undefined,
  startIndex: number,
  endIndex: number,
  selection: string,
  newExpansionId: number,
  startOffset?: number,
  endOffset?: number,
  prompt?: string
): ExpandableSegment[] {
  if (parentExpansionId === undefined) {
    return insertExpansion(
      segments,
      startIndex,
      endIndex,
      selection,
      newExpansionId,
      startOffset,
      endOffset,
      prompt
    ).segments
  }
  return segments.map((seg) => {
    if (seg.kind === 'expansion' && seg.expansionId === parentExpansionId) {
      const result = insertExpansion(
        seg.segments,
        startIndex,
        endIndex,
        selection,
        newExpansionId,
        startOffset,
        endOffset,
        prompt
      )
      return { ...seg, segments: result.segments }
    }
    if (seg.kind === 'expansion') {
      return {
        ...seg,
        segments: insertExpansionNested(
          seg.segments,
          parentExpansionId,
          startIndex,
          endIndex,
          selection,
          newExpansionId,
          startOffset,
          endOffset,
          prompt
        )
      }
    }
    return seg
  })
}

/**
 * Given a segment array, a (trimmed) user selection, and the segment index
 * that was right-clicked (the anchor), find a sub-range of consecutive text
 * segments whose concatenated text equals the selection, such that the anchor
 * segment lies within that range.
 *
 * Returns `{ startIdx: -1, endIdx: -1 }` when no match covers the anchor.
 * When the selection starts or ends mid-segment, returns `startOffset` and/or
 * `endOffset` — character offsets within `segments[startIdx]` and
 * `segments[endIdx - 1]` respectively.
 */
export function findTextSelectionRange(
  segments: ExpandableSegment[],
  selectedText: string,
  anchor: number
): { startIdx: number; endIdx: number; startOffset?: number; endOffset?: number } {
  if (!selectedText || anchor < 0 || anchor >= segments.length) {
    return { startIdx: -1, endIdx: -1 }
  }
  // Fast path: the anchor segment itself exactly equals the selection.
  const anchorSeg = segments[anchor]
  if (anchorSeg.kind === 'text' && anchorSeg.text.trim() === selectedText) {
    return { startIdx: anchor, endIdx: anchor + 1 }
  }
  if (anchorSeg.kind !== 'text') {
    return { startIdx: -1, endIdx: -1 }
  }
  // Find the maximal contiguous run of text segments containing the anchor.
  let runStart = anchor
  while (runStart > 0 && segments[runStart - 1].kind === 'text') runStart--
  let runEnd = anchor
  while (runEnd + 1 < segments.length && segments[runEnd + 1].kind === 'text') runEnd++
  // Concatenate the run's text, tracking per-segment start offsets; a final
  // sentinel records the run's length so an end-boundary at the final char of
  // the last segment resolves to an endIdx of runEnd+1.
  let runChars = ''
  const segStart: number[] = []
  for (let r = runStart; r <= runEnd; r++) {
    segStart.push(runChars.length)
    runChars += (segments[r] as { kind: 'text'; text: string }).text
  }
  segStart.push(runChars.length)
  // Enumerate every occurrence of selectedText in the run and accept the
  // first one that covers the anchor (startIdx <= anchor < endIdx).
  let searchFrom = 0
  while (true) {
    const off = runChars.indexOf(selectedText, searchFrom)
    if (off < 0) break
    const selEnd = off + selectedText.length
    // Find s: largest i such that segStart[i] <= off
    let s = 0
    for (let i = 0; i < segStart.length; i++) {
      if (segStart[i] <= off) s = i
    }
    // Find e: smallest i such that segStart[i] >= selEnd
    let e = segStart.length - 1
    for (let i = 0; i < segStart.length; i++) {
      if (segStart[i] >= selEnd) {
        e = i
        break
      }
    }
    if (e > s) {
      const candStart = runStart + s
      const candEnd = runStart + e
      if (anchor >= candStart && anchor < candEnd) {
        const result: {
          startIdx: number
          endIdx: number
          startOffset?: number
          endOffset?: number
        } = {
          startIdx: candStart,
          endIdx: candEnd
        }
        const startOffset = off - segStart[s]
        const endOffset = selEnd - segStart[e - 1]
        const lastSegText = (segments[candEnd - 1] as { kind: 'text'; text: string }).text
        if (startOffset > 0) result.startOffset = startOffset
        if (endOffset < lastSegText.length) result.endOffset = endOffset
        return result
      }
    }
    searchFrom = off + 1
  }
  return { startIdx: -1, endIdx: -1 }
}

export function updateExpansionInSegments(
  segments: ExpandableSegment[],
  expansionId: number,
  patch: Partial<ExpandableSegment>
): ExpandableSegment[] {
  return segments.map((seg) => {
    if (seg.kind === 'expansion' && seg.expansionId === expansionId) {
      return { ...seg, ...patch } as ExpandableSegment
    }
    if (seg.kind === 'expansion') {
      return { ...seg, segments: updateExpansionInSegments(seg.segments, expansionId, patch) }
    }
    return seg
  })
}

export function toggleExpansionFoldedInSegments(
  segments: ExpandableSegment[],
  expansionId: number,
  folded: boolean
): ExpandableSegment[] {
  return segments.map((seg) => {
    if (seg.kind === 'expansion' && seg.expansionId === expansionId) {
      return { ...seg, folded }
    }
    if (seg.kind === 'expansion') {
      return {
        ...seg,
        segments: toggleExpansionFoldedInSegments(seg.segments, expansionId, folded)
      }
    }
    return seg
  })
}

export function updateExpansionInTurns(
  turns: Turn[],
  expansionId: number,
  patch: Partial<ExpandableSegment>
): Turn[] {
  return turns.map((turn) => {
    if (turn.segments) {
      return { ...turn, segments: updateExpansionInSegments(turn.segments, expansionId, patch) }
    }
    return turn
  })
}

export function toggleExpansionFoldedInTurns(
  turns: Turn[],
  expansionId: number,
  folded: boolean
): Turn[] {
  return turns.map((turn) => {
    if (turn.segments) {
      return {
        ...turn,
        segments: toggleExpansionFoldedInSegments(turn.segments, expansionId, folded)
      }
    }
    return turn
  })
}

/**
 * Serialize a conversation into provider messages.
 *
 * The system prompt is always sent; the screen-context preamble is prepended
 * only when a context exists (or the caller is the lookup window, which always
 * introduces itself as screen-aware).
 */
export function serializeForChat(
  state: ConversationState,
  role?: 'chat' | 'lookup'
): ProviderMessage[] {
  const messages: ProviderMessage[] = [{ role: 'system', content: getSystemPrompt(role) }]

  if (role === 'lookup' || state.context) {
    messages.push({
      role: 'user',
      content: buildScreenContextMessage(state.context ?? '')
    })
  }

  for (const turn of state.turns) {
    messages.push({ role: turn.role, content: turn.content })
  }
  return messages
}

export const CONVERSATION_TITLE_MAX_LENGTH = 60

/** Derive a conversation title from its first user message. */
export function buildConversationTitle(text: string): string {
  const flat = flattenMarkdown(text).replace(/\s+/g, ' ').trim()
  if (flat === '') return 'New conversation'
  if (flat.length <= CONVERSATION_TITLE_MAX_LENGTH) return flat
  return flat.slice(0, CONVERSATION_TITLE_MAX_LENGTH).trimEnd()
}

/** Depth-first lookup of an expansion by id, across nested frames. */
export function findExpansionInSegments(
  segments: ExpandableSegment[],
  expansionId: number
): ExpansionSegment | null {
  for (const seg of segments) {
    if (seg.kind !== 'expansion') continue
    if (seg.expansionId === expansionId) return seg
    const found = findExpansionInSegments(seg.segments, expansionId)
    if (found) return found
  }
  return null
}

/** Highest expansion id in the tree, so counter allocation can resume past it. */
export function maxExpansionId(turns: Turn[]): number {
  let max = 0
  const visit = (segments: ExpandableSegment[] | undefined): void => {
    if (!segments) return
    for (const seg of segments) {
      if (seg.kind !== 'expansion') continue
      if (seg.expansionId > max) max = seg.expansionId
      visit(seg.segments)
    }
  }
  for (const turn of turns) visit(turn.segments)
  return max
}
