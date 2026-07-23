export interface ProviderMessage {
  role: string
  content: string
}

export type ExpandableSegment =
  | { kind: 'text'; text: string }
  | {
      kind: 'expansion'
      expansionId: number
      originalText: string
      cachedText: string
      error?: string
      loading?: boolean
      folded: boolean
      segments: ExpandableSegment[]
    }

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
  const parts = flattened.split(/(\s+)/)
  for (const part of parts) {
    if (part === '') continue
    segments.push({ kind: 'text', text: part })
  }
  return segments
}

export function insertExpansion(
  segments: ExpandableSegment[],
  startIndex: number,
  endIndex: number,
  selection: string,
  newExpansionId: number
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
    loading: true,
    folded: false,
    segments: []
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
  newExpansionId: number
): ExpandableSegment[] {
  if (parentExpansionId === undefined) {
    return insertExpansion(segments, startIndex, endIndex, selection, newExpansionId).segments
  }
  return segments.map((seg) => {
    if (seg.kind === 'expansion' && seg.expansionId === parentExpansionId) {
      const result = insertExpansion(seg.segments, startIndex, endIndex, selection, newExpansionId)
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
          newExpansionId
        )
      }
    }
    return seg
  })
}

/**
 * Given a segment array, a (trimmed) user selection, and the segment index
 * that was right-clicked (the anchor), find a sub-range of consecutive text
 * segments whose concatenated text equals the selection, aligned to segment
 * boundaries, such that the anchor segment lies within that range.
 *
 * Returns `{ startIdx: -1, endIdx: -1 }` when no boundary-aligned match
 * covers the anchor — the caller treats that as "cannot expand".
 *
 * The old ad-hoc matching scanned from the start of the array and matched on
 * "selection startsWith seg.text" / "selection endsWith seg.text". That
 * silently picked the wrong occurrence when the same word appeared more than
 * once before the anchor (e.g. "the" appearing twice in a paragraph and the
 * user only selecting the second one) — the early match could span an
 * expansion boundary and falsely disable Expand. Anchoring on the click and
 * requiring character alignment to segment boundaries fixes both classes.
 */
export function findTextSelectionRange(
  segments: ExpandableSegment[],
  selectedText: string,
  anchor: number
): { startIdx: number; endIdx: number } {
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
  // first one that aligns to segment boundaries AND covers the anchor.
  let searchFrom = 0
  while (true) {
    const off = runChars.indexOf(selectedText, searchFrom)
    if (off < 0) break
    const selEnd = off + selectedText.length
    const s = segStart.indexOf(off)
    // Find the first segment boundary >= selEnd. When the user's exact
    // selection ends mid-segment (e.g. trailing punctuation tokenized
    // together with the word, like "processes," but the user selected
    // "processes"), this includes the full containing segment rather than
    // failing the alignment check.
    let e = segStart.length - 1
    for (let i = 0; i < segStart.length; i++) {
      if (segStart[i] >= selEnd) {
        e = i
        break
      }
    }
    if (s >= 0 && e > s) {
      const candStart = runStart + s
      const candEnd = runStart + e
      if (anchor >= candStart && anchor < candEnd) {
        return { startIdx: candStart, endIdx: candEnd }
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

import { getSystemPrompt, buildScreenContextMessage } from './prompts'

export function serializeForChat(
  state: ConversationState,
  role?: 'chat' | 'lookup'
): ProviderMessage[] {
  const messages: ProviderMessage[] = []

  if (role === 'lookup' || state.context) {
    messages.push({ role: 'system', content: getSystemPrompt(role) })
    messages.push({
      role: 'user',
      content: buildScreenContextMessage(state.context!)
    })
  }

  for (const turn of state.turns) {
    messages.push({ role: turn.role, content: turn.content })
  }
  return messages
}

export function findExpansionParent(
  segments: ExpandableSegment[],
  expansionId: number
): { parentText: string; isNested: boolean } | null {
  for (const seg of segments) {
    if (seg.kind === 'expansion') {
      if (seg.expansionId === expansionId) {
        return { parentText: seg.cachedText || seg.originalText, isNested: true }
      }
      const found = findExpansionParent(seg.segments, expansionId)
      if (found) return { ...found, isNested: true }
    }
  }
  return null
}
