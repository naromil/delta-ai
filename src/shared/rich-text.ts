/**
 * Rich text model: a single markdown `content` string plus `ExpansionNode`
 * annotations anchored by absolute source offsets.
 *
 * This module is pure: no React, no DOM, no parser. It owns the tree
 * invariants (bounds, overlap, nesting), the streaming patch rules and the
 * legacy segment migration.
 */

export type ExpansionStatus = 'loading' | 'done' | 'error'

export interface ExpansionNode {
  id: number
  /** Absolute offset into the enclosing source (`content` or the parent `answer`). */
  start: number
  end: number
  /** Markdown slice of the enclosing source covered by this expansion. */
  originalText: string
  /** Markdown answer streamed from the model. */
  answer: string
  prompt?: string
  /**
   * Terminal status. A node is streaming while `status === 'loading'`; a
   * loading node with a non-empty `answer` is already showing text.
   */
  status: ExpansionStatus
  error?: string
  folded: boolean
  /** Offsets are relative to this node's `answer`. */
  children: ExpansionNode[]
}

export interface ExpansionRange {
  start: number
  end: number
}

/** Insertion target: an offset range in a turn body or in one expansion answer. */
export interface ExpansionTarget extends ExpansionRange {
  parentExpansionId?: number
  /** The text the user actually selected, for the submit-time equality check. */
  selection?: string
}

/** Fields a caller may change on an existing node. Structure is immutable. */
export interface ExpansionPatch {
  answer?: string
  status?: ExpansionStatus
  error?: string
  prompt?: string
  folded?: boolean
}

export interface RichTextTurn {
  id: number
  content: string
  expansions: ExpansionNode[]
}

export interface ExpansionLocation {
  node: ExpansionNode
  parent: ExpansionNode | null
  /** The sibling array the node lives in (turn `expansions` or parent `children`). */
  siblings: ExpansionNode[]
}

export interface ExpansionTurnLocation extends ExpansionLocation {
  turn: RichTextTurn
}

export type InsertionRefusal =
  | 'out-of-bounds'
  | 'empty-range'
  | 'blank-selection'
  | 'cross-block'
  | 'overlaps-expansion'
  | 'inside-expansion'
  | 'selection-mismatch'

export type ExpandRefusal = InsertionRefusal | 'turn-not-found' | 'parent-not-found'

export type InsertExpansionResult =
  | { ok: true; expansions: ExpansionNode[]; node: ExpansionNode }
  | { ok: false; reason: InsertionRefusal }

export type InsertExpansionInTurnsResult<T extends RichTextTurn> =
  { ok: true; turns: T[] } | { ok: false; reason: ExpandRefusal }

export interface ExpansionMessageInput {
  answer: string
  selection: string
}

/** One `chat-expand-chunk` payload (`text` is cumulative). */
export interface ExpansionChunk {
  text?: string
  done?: boolean
  error?: string
}

export const EXPANSION_EMPTY_ERROR = 'No output returned.'
export const EXPANSION_INTERRUPTED_ERROR = 'Response interrupted.'

/* ---- Markdown flattening ---- */

export function flattenMarkdown(text: string): string {
  let flat = text.replace(/^#{1,6}\s+/gm, '')
  flat = flat.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
  flat = flat.replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
  flat = flat.replace(/`([^`]+)`/g, '$1')
  flat = flat.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  flat = flat.replace(/^[\s]*[-*+]\s+/gm, '\u00b7 ')
  flat = flat.replace(/^[\s]*\d+\.\s+/gm, '\u00b7 ')
  flat = flat.replace(/^>\s+/gm, '')
  flat = flat.replace(/^[-*_]{3,}\s*$/gm, '')
  return flat
}

/* ---- Block boundaries ---- */

const BLOCK_LINE = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|[-*+][ \t]|\d{1,9}[.)][ \t]|\||```|~~~| {4}\S)/
const BLANK_LINE = /^[ \t]*$/

function isBlockBoundaryAt(source: string, offset: number): boolean {
  const previousEnd = offset - 1
  if (previousEnd > 0) {
    const previousStart = source.lastIndexOf('\n', previousEnd - 1) + 1
    if (BLANK_LINE.test(source.slice(previousStart, previousEnd))) return true
  }
  const lineEnd = source.indexOf('\n', offset)
  const line = source.slice(offset, lineEnd < 0 ? source.length : lineEnd)
  return BLOCK_LINE.test(line)
}

/**
 * True when the range covers a markdown block boundary (blank line, new list
 * item, heading, quote, table row, fence). Such a selection cannot be replaced
 * by a single inline annotation.
 */
export function crossesBlockBoundary(source: string, start: number, end: number): boolean {
  let offset = source.indexOf('\n', start) + 1
  while (offset > 0 && offset < end) {
    if (isBlockBoundaryAt(source, offset)) return true
    const next = source.indexOf('\n', offset)
    if (next < 0) break
    offset = next + 1
  }
  return false
}

/* ---- Insertion ---- */

/** Returns the refusal reason, or `null` when the target is expandable. */
export function validateInsertion(
  source: string,
  expansions: ExpansionNode[],
  range: ExpansionRange
): InsertionRefusal | null {
  const { start, end } = range
  const inBounds =
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end <= source.length &&
    start <= end
  if (!inBounds) return 'out-of-bounds'
  if (start === end) return 'empty-range'
  if (source.slice(start, end).trim() === '') return 'blank-selection'

  for (const node of expansions) {
    if (end <= node.start || start >= node.end) continue
    if (start >= node.start && end <= node.end) return 'inside-expansion'
    return 'overlaps-expansion'
  }

  if (crossesBlockBoundary(source, start, end)) return 'cross-block'
  return null
}

/**
 * Full target validation, including the equality check against the text the
 * user selected. Offsets are re-resolved at submit time, but the source may
 * have changed underneath a stale snapshot; the covered slice must match.
 *
 * The comparison is exact and untrimmed by design: the renderer only anchors a
 * range inside one mdast text node, whose rendered text *is* the source slice
 * (markdown markers live outside text nodes), so `Selection.toString()` and
 * `source.slice(start, end)` agree byte for byte. A selection that includes
 * markdown markers necessarily spans several nodes and is refused by the
 * renderer's `isAnchoredRange` check before this function runs.
 */
export function validateExpansionTarget(
  source: string,
  expansions: ExpansionNode[],
  target: ExpansionTarget
): InsertionRefusal | null {
  if (
    target.selection !== undefined &&
    source.slice(target.start, target.end) !== target.selection
  ) {
    return 'selection-mismatch'
  }
  return validateInsertion(source, expansions, target)
}

export function insertExpansion(
  source: string,
  expansions: ExpansionNode[],
  target: ExpansionTarget,
  id: number,
  prompt?: string
): InsertExpansionResult {
  const refusal = validateExpansionTarget(source, expansions, target)
  if (refusal) return { ok: false, reason: refusal }

  const node: ExpansionNode = {
    id,
    start: target.start,
    end: target.end,
    originalText: source.slice(target.start, target.end),
    answer: '',
    ...(prompt !== undefined ? { prompt } : {}),
    status: 'loading',
    folded: false,
    children: []
  }

  const next = [...expansions, node].sort((a, b) => a.start - b.start)
  return { ok: true, expansions: next, node }
}

/* ---- Lookup ---- */

export function findExpansionInNodes(nodes: ExpansionNode[], id: number): ExpansionLocation | null {
  for (const node of nodes) {
    if (node.id === id) return { node, parent: null, siblings: nodes }
    const found = findExpansionInNodes(node.children, id)
    if (found) {
      return { node: found.node, parent: found.parent ?? node, siblings: found.siblings }
    }
  }
  return null
}

/** First match only: ids are unique, a duplicate must never fan out an update. */
export function findExpansionInTurns<T extends RichTextTurn>(
  turns: T[],
  id: number
): (ExpansionTurnLocation & { turn: T }) | null {
  for (const turn of turns) {
    const found = findExpansionInNodes(turn.expansions, id)
    if (found) return { ...found, turn }
  }
  return null
}

/** Highest expansion id across turns and nesting levels. */
export function maxExpansionId(turns: RichTextTurn[]): number {
  let max = 0
  const visit = (nodes: ExpansionNode[]): void => {
    for (const node of nodes) {
      if (node.id > max) max = node.id
      visit(node.children)
    }
  }
  for (const turn of turns) visit(turn.expansions)
  return max
}

/* ---- Updates ---- */

function patchMatches(node: ExpansionNode, patch: ExpansionPatch): boolean {
  return (Object.keys(patch) as Array<keyof ExpansionPatch>).every(
    (key) => node[key] === patch[key]
  )
}

function updateInNodes(
  nodes: ExpansionNode[],
  id: number,
  patch: ExpansionPatch,
  state: { matched: boolean }
): ExpansionNode[] {
  let changed = false
  const next = nodes.map((node) => {
    if (state.matched) return node
    if (node.id === id) {
      state.matched = true
      if (patchMatches(node, patch)) return node
      changed = true
      return { ...node, ...patch }
    }
    const children = updateInNodes(node.children, id, patch, state)
    if (children === node.children) return node
    changed = true
    return { ...node, children }
  })
  return changed ? next : nodes
}

/** Apply a non-structural patch to one expansion, at any depth. */
export function updateExpansion<T extends RichTextTurn>(
  turns: T[],
  id: number,
  patch: ExpansionPatch
): T[] {
  const state = { matched: false }
  let changed = false
  const next = turns.map((turn) => {
    if (state.matched) return turn
    const expansions = updateInNodes(turn.expansions, id, patch, state)
    if (expansions === turn.expansions) return turn
    changed = true
    return { ...turn, expansions }
  })
  return changed ? next : turns
}

export function setExpansionFolded<T extends RichTextTurn>(
  turns: T[],
  id: number,
  folded: boolean
): T[] {
  return updateExpansion(turns, id, { folded })
}

function removeInNodes(
  nodes: ExpansionNode[],
  id: number,
  state: { removed: boolean }
): ExpansionNode[] {
  let changed = false
  const next: ExpansionNode[] = []
  for (const node of nodes) {
    if (!state.removed && node.id === id) {
      state.removed = true
      changed = true
      continue
    }
    const children = removeInNodes(node.children, id, state)
    if (children === node.children) {
      next.push(node)
      continue
    }
    changed = true
    next.push({ ...node, children })
  }
  return changed ? next : nodes
}

/** Removes one expansion (and its subtree). First match only. */
export function removeExpansionInTurns<T extends RichTextTurn>(turns: T[], id: number): T[] {
  const state = { removed: false }
  let changed = false
  const next = turns.map((turn) => {
    if (state.removed) return turn
    const expansions = removeInNodes(turn.expansions, id, state)
    if (expansions === turn.expansions) return turn
    changed = true
    return { ...turn, expansions }
  })
  return changed ? next : turns
}

/* ---- Streaming ---- */

/**
 * Applies one streaming chunk to one expansion. Text chunks only ever touch
 * that node's `answer`: children and offsets are structurally untouchable.
 * `status` stays `'loading'` until `done`, so a frame never claims completion
 * on its first token. A `done` with no output becomes an explicit error.
 */
export function applyExpansionChunk<T extends RichTextTurn>(
  turns: T[],
  id: number,
  chunk: ExpansionChunk
): T[] {
  const location = findExpansionInTurns(turns, id)
  if (!location) return turns

  if (chunk.error !== undefined) {
    return updateExpansion(turns, id, { status: 'error', error: chunk.error })
  }

  let next = turns
  if (chunk.text !== undefined && chunk.text !== '') {
    next = updateExpansion(next, id, { answer: chunk.text })
  }
  if (chunk.done) {
    const text = chunk.text ?? location.node.answer
    next =
      text.trim() === ''
        ? updateExpansion(next, id, { status: 'error', error: EXPANSION_EMPTY_ERROR })
        : updateExpansion(next, id, { status: 'done' })
  }
  return next
}

/**
 * Converts any transient `loading` node into a recoverable error state. Used
 * on every save and on every load/transfer, so a persisted conversation can
 * never contain a frame that waits forever.
 */
export function finalizeExpansions(nodes: ExpansionNode[]): ExpansionNode[] {
  let changed = false
  const next = nodes.map((node) => {
    let result = node
    if (node.status === 'loading') {
      changed = true
      result = {
        ...node,
        status: 'error',
        error: node.answer.trim() === '' ? EXPANSION_EMPTY_ERROR : EXPANSION_INTERRUPTED_ERROR
      }
    }
    const children = finalizeExpansions(node.children)
    if (children !== result.children) {
      changed = true
      result = { ...result, children }
    }
    return result
  })
  return changed ? next : nodes
}

export function finalizeTurns<T extends RichTextTurn>(turns: T[]): T[] {
  let changed = false
  const next = turns.map((turn) => {
    const expansions = finalizeExpansions(turn.expansions)
    if (expansions === turn.expansions) return turn
    changed = true
    return { ...turn, expansions }
  })
  return changed ? next : turns
}

/* ---- Turn-scoped operations ---- */

export function insertExpansionInTurns<T extends RichTextTurn>(
  turns: T[],
  turnId: number,
  target: ExpansionTarget,
  newExpansionId: number,
  prompt?: string
): InsertExpansionInTurnsResult<T> {
  const index = turns.findIndex((turn) => turn.id === turnId)
  if (index < 0) return { ok: false, reason: 'turn-not-found' }
  const turn = turns[index]

  const parentId = target.parentExpansionId
  const source = parentId === undefined ? turn.content : undefined
  const parent = parentId === undefined ? null : findExpansionInNodes(turn.expansions, parentId)
  if (parentId !== undefined && !parent) return { ok: false, reason: 'parent-not-found' }

  const result = insertExpansion(
    parent ? parent.node.answer : (source as string),
    parent ? parent.node.children : turn.expansions,
    target,
    newExpansionId,
    prompt
  )
  if (!result.ok) return { ok: false, reason: result.reason }

  const expansions = parent
    ? replaceChildren(turn.expansions, parentId as number, result.expansions)
    : result.expansions

  return {
    ok: true,
    turns: turns.map((item, i) => (i === index ? { ...item, expansions } : item))
  }
}

function replaceChildren(
  nodes: ExpansionNode[],
  id: number,
  children: ExpansionNode[]
): ExpansionNode[] {
  let matched = false
  const next = nodes.map((node) => {
    if (matched) return node
    if (node.id === id) {
      matched = true
      return { ...node, children }
    }
    const nested = replaceChildren(node.children, id, children)
    return nested === node.children ? node : { ...node, children: nested }
  })
  return matched ? next : nodes
}

/**
 * Input for `buildExpandMessages`: the markdown the model should see as its own
 * previous answer plus the selected excerpt. `parentId` selects a nested scope.
 */
export function expansionMessageInput(
  turn: RichTextTurn,
  parentId: number | undefined,
  range: ExpansionRange
): ExpansionMessageInput | null {
  const source =
    parentId === undefined
      ? turn.content
      : findExpansionInNodes(turn.expansions, parentId)?.node.answer
  if (source === undefined) return null
  if (range.start < 0 || range.end > source.length || range.start >= range.end) return null
  return { answer: source, selection: source.slice(range.start, range.end) }
}

/* ---- Legacy migration ---- */

export interface LegacyTextSegment {
  kind: 'text'
  text: string
}

export interface LegacyExpansionSegment {
  kind: 'expansion'
  expansionId: number
  originalText: string
  cachedText: string
  prompt?: string
  error?: string
  loading?: boolean
  folded: boolean
  segments: LegacySegment[]
}

export type LegacySegment = LegacyTextSegment | LegacyExpansionSegment

export interface LegacyTurn {
  id: number
  role: 'user' | 'assistant'
  content: string
  expansions?: ExpansionNode[]
  segments?: LegacySegment[]
  error?: boolean
}

function legacyStatus(segment: LegacyExpansionSegment, hasAnswer: boolean): ExpansionStatus {
  if (segment.error) return 'error'
  if (hasAnswer) return 'done'
  return segment.loading ? 'loading' : 'done'
}

/**
 * Rebuilds `{ content, expansions }` from the pre-offset segment tree. Legacy
 * segments were already markdown-flattened, so the reconstructed content is
 * flat: old conversations keep the text they were rendered with.
 */
export function migrateLegacySegments(segments: LegacySegment[]): {
  content: string
  expansions: ExpansionNode[]
} {
  let content = ''
  const expansions: ExpansionNode[] = []

  for (const segment of segments) {
    if (segment.kind === 'text') {
      content += segment.text
      continue
    }

    const start = content.length
    content += segment.originalText
    const nested = segment.segments.length > 0 ? migrateLegacySegments(segment.segments) : null
    const answer = nested ? nested.content : segment.cachedText

    expansions.push({
      id: segment.expansionId,
      start,
      end: content.length,
      originalText: segment.originalText,
      answer,
      ...(segment.prompt !== undefined ? { prompt: segment.prompt } : {}),
      status: legacyStatus(segment, answer !== ''),
      ...(segment.error !== undefined ? { error: segment.error } : {}),
      folded: segment.folded,
      children: nested ? nested.expansions : []
    })
  }

  return { content, expansions }
}

/**
 * Normalizes one persisted turn. Turns without expansions keep their markdown
 * `content` untouched; turns built from segments are flattened into a
 * `content` string with offset-anchored expansions.
 */
export function migrateLegacyTurn<T extends LegacyTurn>(
  turn: T
): Omit<T, 'segments'> & { expansions: ExpansionNode[] } {
  const { segments, ...rest } = turn
  if (turn.expansions !== undefined) return { ...rest, expansions: turn.expansions }

  const hasExpansion = segments?.some((segment) => segment.kind === 'expansion') ?? false
  if (!segments || !hasExpansion) return { ...rest, expansions: [] }

  const { content, expansions } = migrateLegacySegments(segments)
  return { ...rest, content, expansions }
}

export function migrateLegacyTurns<T extends LegacyTurn>(
  turns: T[]
): Array<Omit<T, 'segments'> & { expansions: ExpansionNode[] }> {
  return turns.map((turn) => migrateLegacyTurn(turn))
}
