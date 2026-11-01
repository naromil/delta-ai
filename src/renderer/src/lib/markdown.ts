/**
 * Markdown source helpers shared by the renderer and the selection mapper.
 * Pure: parser + tree surgery, no React and no DOM access.
 */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
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
  lang?: string | null
  position?: MarkdownPosition
  children?: MarkdownNode[]
}

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath)

function offsetAt(position: MarkdownPosition | undefined, side: 'start' | 'end'): number | null {
  const offset = position?.[side].offset
  return typeof offset === 'number' ? offset : null
}

function walk(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
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

/* ---- Math delimiters ----
 * Models write math as `$…$`, `$$…$$`, `\(…\)` or `\[…\]`. remark-math only knows the
 * dollar forms, and every expansion anchor is an absolute source offset, so the bracket
 * forms are rewritten to `$$` *in place*: both delimiters are two characters long, so no
 * offset moves.
 */

const INLINE_BRACKET_MATH = /(?<!\\)\\\(((?:(?!\n[ \t]*\n)[\s\S])+?)\\\)/g
/** One line, or the delimiters alone on their own lines (the only shapes `$$` can express). */
const DISPLAY_BRACKET_MATH =
  /^[ \t>]*(?<!\\)\\\[(?:[^\n]+?|[ \t]*\n(?:(?![ \t>]*\n)[\s\S])*?\n[ \t>]*)\\\][ \t]*$/gm

function codeRanges(tree: MarkdownNode): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  walk(tree, (node) => {
    if (node.type !== 'code' && node.type !== 'inlineCode') return
    const start = offsetAt(node.position, 'start')
    const end = offsetAt(node.position, 'end')
    if (start !== null && end !== null) ranges.push([start, end])
  })
  return ranges
}

function normalizeBracketMath(source: string): string {
  if (!source.includes('\\(') && !source.includes('\\[')) return source

  // Code keeps its backslashes: `\(` in a regex example is not math.
  const code = codeRanges(processor.parse(source) as unknown as MarkdownNode)
  const inCode = (offset: number): boolean =>
    code.some(([start, end]) => start <= offset && offset < end)
  const chars = source.split('')

  const rewrite = (open: number, close: number): void => {
    if (inCode(open) || inCode(close)) return
    chars[open] = chars[open + 1] = chars[close] = chars[close + 1] = '$'
  }
  for (const match of source.matchAll(INLINE_BRACKET_MATH)) {
    rewrite(match.index, match.index + match[0].length - 2)
  }
  for (const match of source.matchAll(DISPLAY_BRACKET_MATH)) {
    const open = match.index + match[0].indexOf('\\[')
    rewrite(open, match.index + match[0].lastIndexOf('\\]'))
  }
  return chars.join('')
}

/**
 * A prose dollar amount is not math. Pandoc's rule: the opening `$` is followed by a
 * non-space, the closing `$` follows a non-space and is not followed by a digit. That
 * keeps `$x^2$` while refusing "$5 and $10" and "$5-$10".
 */
function isProseDollarSpan(source: string, start: number, end: number): boolean {
  if (source[start] !== '$' || source[start + 1] === '$') return false
  return /\s/.test(source[start + 1]) || /\s/.test(source[end - 2]) || /\d/.test(source[end] ?? '')
}

/** Turns prose dollar spans back into text, merged so selections can still span them. */
function demoteProseDollars(node: MarkdownNode, source: string): void {
  if (!node.children) return
  const children: MarkdownNode[] = []
  for (const original of node.children) {
    let child = original
    const start = offsetAt(child.position, 'start')
    const end = offsetAt(child.position, 'end')
    if (
      child.type === 'inlineMath' &&
      start !== null &&
      end !== null &&
      isProseDollarSpan(source, start, end)
    ) {
      child = textNode(source.slice(start, end), start, end)
    }

    const previous = children[children.length - 1]
    if (
      child.type === 'text' &&
      previous?.type === 'text' &&
      start !== null &&
      end !== null &&
      offsetAt(previous.position, 'end') === start
    ) {
      children[children.length - 1] = textNode(
        (previous.value ?? '') + (child.value ?? ''),
        offsetAt(previous.position, 'start') ?? start,
        end
      )
      continue
    }
    demoteProseDollars(child, source)
    children.push(child)
  }
  node.children = children
}

export function parseMarkdown(source: string): MarkdownNode {
  const tree = processor.parse(normalizeBracketMath(source)) as unknown as MarkdownNode
  demoteProseDollars(tree, source)
  return tree
}

/** `$$x$$` and `\[x\]` written on one line parse as inline math but are meant as display. */
export function isDisplayMath(source: string, node: MarkdownNode): boolean {
  const start = offsetAt(node.position, 'start')
  if (start === null) return false
  const delimiter = source.slice(start, start + 2)
  return delimiter === '$$' || delimiter === '\\['
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
