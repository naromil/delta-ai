/**
 * Markdown source helpers shared by the renderer and the selection mapper.
 * Pure: parser + tree surgery, no React and no DOM access.
 */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { ExpansionNode, ExpansionRange } from '../../../shared/rich-text'

export const SOURCED_TEXT = 'sourcedText'
export const EXPANSION_NODE = 'expansion'

export interface MarkdownPosition {
  start: { line: number; column: number; offset?: number }
  end: { line: number; column: number; offset?: number }
}

export interface MarkdownNode {
  type: string
  value?: string
  id?: number
  src?: number
  position?: MarkdownPosition
  children?: MarkdownNode[]
}

const processor = unified().use(remarkParse).use(remarkGfm)

export function parseMarkdown(source: string): MarkdownNode {
  return processor.parse(source) as unknown as MarkdownNode
}

function offsetAt(position: MarkdownPosition | undefined, side: 'start' | 'end'): number | null {
  const offset = position?.[side].offset
  return typeof offset === 'number' ? offset : null
}

function walk(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

const TEXT_SPAN_CACHE_LIMIT = 32

/** Parsing is the expensive part of anchoring; keep the newest sources only. */
const textSpanCache = new Map<string, ExpansionRange[]>()

/** Absolute source offsets of every mdast `text` node, in document order. */
export function collectTextNodeSpans(source: string): ExpansionRange[] {
  const cached = textSpanCache.get(source)
  if (cached) return cached

  const spans: ExpansionRange[] = []
  walk(parseMarkdown(source), (node) => {
    if (node.type !== 'text') return
    const start = offsetAt(node.position, 'start')
    const end = offsetAt(node.position, 'end')
    if (start === null || end === null) return
    spans.push({ start, end })
  })

  textSpanCache.set(source, spans)
  if (textSpanCache.size > TEXT_SPAN_CACHE_LIMIT) {
    const oldest = textSpanCache.keys().next().value
    if (oldest !== undefined) textSpanCache.delete(oldest)
  }
  return spans
}

/**
 * An expansion can only be spliced into a single mdast text node: that keeps
 * the annotation inside one block and one phrasing run, so replacing the range
 * with an inline element is always valid.
 */
export function isAnchoredRange(source: string, range: ExpansionRange): boolean {
  if (range.start >= range.end) return false
  return collectTextNodeSpans(source).some(
    (span) => span.start <= range.start && range.end <= span.end
  )
}

function textNode(value: string, startOffset: number, endOffset: number): MarkdownNode {
  return {
    type: 'text',
    value,
    position: {
      start: { line: 1, column: 1, offset: startOffset },
      end: { line: 1, column: 1, offset: endOffset }
    }
  }
}

function spliceInChildren(parent: MarkdownNode, expansion: ExpansionNode): boolean {
  const children = parent.children
  if (!children) return false

  for (let index = 0; index < children.length; index++) {
    const child = children[index]
    const start = offsetAt(child.position, 'start')
    const end = offsetAt(child.position, 'end')
    if (start === null || end === null) continue
    if (end <= expansion.start || start >= expansion.end) continue

    if (child.type === 'text' && start <= expansion.start && expansion.end <= end) {
      const value = child.value ?? ''
      const localStart = expansion.start - start
      const localEnd = expansion.end - start
      const before = value.slice(0, localStart)
      const after = value.slice(localEnd)

      const replacement: MarkdownNode[] = []
      if (before !== '') replacement.push(textNode(before, start, expansion.start))
      replacement.push({ type: EXPANSION_NODE, id: expansion.id })
      if (after !== '') replacement.push(textNode(after, expansion.end, end))

      children.splice(index, 1, ...replacement)
      return true
    }

    if (start <= expansion.start && expansion.end <= end && spliceInChildren(child, expansion)) {
      return true
    }
  }

  return false
}

function markSourceText(node: MarkdownNode): void {
  if (node.type === 'text') {
    const start = offsetAt(node.position, 'start')
    node.type = SOURCED_TEXT
    node.src = start ?? 0
    return
  }
  for (const child of node.children ?? []) markSourceText(child)
}

/**
 * Parses `source` and splices every anchored expansion into the tree as an
 * `expansion` node between split text fragments. Each remaining text node is
 * converted to a `sourcedText` node carrying its absolute source offset.
 */
export function prepareMarkdownTree(source: string, expansions: ExpansionNode[]): MarkdownNode {
  const tree = parseMarkdown(source)
  const ordered = [...expansions].sort((a, b) => a.start - b.start)
  for (const expansion of ordered) spliceInChildren(tree, expansion)
  markSourceText(tree)
  return tree
}
