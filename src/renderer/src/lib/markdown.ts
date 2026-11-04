/**
 * Markdown source helpers shared by the renderer and the selection mapper.
 * Pure: parser + tree surgery, no React and no DOM access.
 */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import type { ExpansionNode, ExpansionRange } from '../../../shared/rich-text'
import { activeExpansion, isSameRange } from '../../../shared/rich-text'

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

/* ---- Anchoring ----
 * An expansion replaces its range with one inline element, so a range must be
 * something that can be lifted out of the tree whole: part of one text node, a
 * run of siblings in one phrasing parent, or one code block or formula.
 */

/** Rendered without `data-src` text and only ever targeted as a whole. */
const ATOMS = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'image'])
const INLINE_WRAPPERS = new Set(['strong', 'emphasis', 'delete', 'link', 'linkReference'])
const PHRASING_PARENTS = new Set(['paragraph', 'heading', 'tableCell', ...INLINE_WRAPPERS])

export interface AnchoredRange extends ExpansionRange {
  /**
   * `text`: inside one text node, where the rendered text is the source slice.
   * `inline`: covers markdown markers (bold, a link, inline code among words).
   * `atom`: exactly one code block, formula, inline code span or image.
   */
  kind: 'text' | 'inline' | 'atom'
}

function overlappingChildren(node: MarkdownNode, range: ExpansionRange): MarkdownNode[] {
  return (node.children ?? []).filter((child) => {
    const start = offsetAt(child.position, 'start')
    const end = offsetAt(child.position, 'end')
    return start !== null && end !== null && end > range.start && start < range.end
  })
}

/** Whether DOM offsets inside this text node map 1:1 to the source (no escapes, no quote markers). */
function isVerbatimText(node: MarkdownNode, source: string): boolean {
  const start = offsetAt(node.position, 'start') ?? 0
  const end = offsetAt(node.position, 'end') ?? 0
  return source.slice(start, end) === node.value
}

function anchorInRun(
  parent: MarkdownNode,
  run: MarkdownNode[],
  range: ExpansionRange,
  source: string
): AnchoredRange | null {
  if (!PHRASING_PARENTS.has(parent.type)) return null
  const first = run[0]
  const last = run[run.length - 1]
  const firstStart = offsetAt(first.position, 'start') ?? 0
  const lastEnd = offsetAt(last.position, 'end') ?? 0
  if (first.type === 'text' && !isVerbatimText(first, source)) return null
  if (last.type === 'text' && !isVerbatimText(last, source)) return null
  return {
    // An edge inside bold or a link takes in the whole element: it cannot be split.
    start: first.type === 'text' ? Math.max(range.start, firstStart) : firstStart,
    end: last.type === 'text' ? Math.min(range.end, lastEnd) : lastEnd,
    kind: 'inline'
  }
}

function anchorIn(node: MarkdownNode, range: ExpansionRange, source: string): AnchoredRange | null {
  const overlapping = overlappingChildren(node, range)
  if (overlapping.length === 0) return null
  if (overlapping.length > 1) return anchorInRun(node, overlapping, range, source)

  const child = overlapping[0]
  const start = offsetAt(child.position, 'start') ?? 0
  const end = offsetAt(child.position, 'end') ?? 0
  if (child.type === 'text') {
    return { start: Math.max(range.start, start), end: Math.min(range.end, end), kind: 'text' }
  }
  if (ATOMS.has(child.type)) return { start, end, kind: 'atom' }
  if (INLINE_WRAPPERS.has(child.type) && range.start <= start && range.end >= end) {
    return { start, end, kind: 'inline' }
  }
  return anchorIn(child, range, source)
}

/**
 * The range an expansion would actually take for a selection: edges that fall
 * inside an element that cannot be split widen to cover it. `null` when the
 * selection cannot become one inline element (it crosses a block boundary).
 */
export function anchoredRange(source: string, range: ExpansionRange): AnchoredRange | null {
  if (range.start >= range.end) return null
  return anchorIn(parseMarkdown(source), range, source)
}

/** Whether an expansion can sit on exactly this range. */
export function isAnchoredRange(source: string, range: ExpansionRange): boolean {
  const anchored = anchoredRange(source, range)
  return anchored !== null && anchored.start === range.start && anchored.end === range.end
}

/** Whether this slice shows the same with or without markdown rendering. */
export function isPlainMarkdown(text: string): boolean {
  if (!/[*_`$~[\]\\]|^\s*(#|>|\d+[.)]\s|[-+]\s)/m.test(text)) return true
  const [block, ...rest] = parseMarkdown(text).children ?? []
  if (rest.length > 0 || block?.type !== 'paragraph') return false
  const [inner, ...others] = block.children ?? []
  return others.length === 0 && inner?.type === 'text' && inner.value === text
}

function spliceRun(
  children: MarkdownNode[],
  firstIndex: number,
  lastIndex: number,
  expansion: ExpansionNode
): void {
  const first = children[firstIndex]
  const last = children[lastIndex]
  const nodes: MarkdownNode[] = []
  if (first.type === 'text') {
    const start = offsetAt(first.position, 'start') ?? 0
    const before = (first.value ?? '').slice(0, expansion.start - start)
    if (before !== '') nodes.push(textNode(before, start, expansion.start))
  }
  nodes.push({ type: EXPANSION_NODE, id: expansion.id })
  if (last.type === 'text') {
    const start = offsetAt(last.position, 'start') ?? 0
    const end = offsetAt(last.position, 'end') ?? 0
    const after = (last.value ?? '').slice(expansion.end - start)
    if (after !== '') nodes.push(textNode(after, expansion.end, end))
  }
  children.splice(firstIndex, lastIndex - firstIndex + 1, ...nodes)
}

function spliceInChildren(parent: MarkdownNode, expansion: ExpansionNode): boolean {
  const children = parent.children
  if (!children) return false
  const overlapping = overlappingChildren(parent, expansion)
  if (overlapping.length === 0) return false

  const firstIndex = children.indexOf(overlapping[0])
  const lastIndex = children.indexOf(overlapping[overlapping.length - 1])
  const first = overlapping[0]
  const last = overlapping[overlapping.length - 1]
  const start = offsetAt(first.position, 'start') ?? 0
  const end = offsetAt(last.position, 'end') ?? 0

  if (overlapping.length > 1) {
    if (!PHRASING_PARENTS.has(parent.type)) return false
    // An edge may only cut a text node; anything else must lie inside the range.
    if (first.type !== 'text' && start < expansion.start) return false
    if (last.type !== 'text' && end > expansion.end) return false
    if (first.type === 'text' && start > expansion.start) return false
    if (last.type === 'text' && end < expansion.end) return false
    spliceRun(children, firstIndex, lastIndex, expansion)
    return true
  }

  const contains = start <= expansion.start && expansion.end <= end
  if (!contains) return false
  if (first.type === 'text') {
    spliceRun(children, firstIndex, firstIndex, expansion)
    return true
  }
  const isWhole = start === expansion.start && end === expansion.end
  if (isWhole && (ATOMS.has(first.type) || INLINE_WRAPPERS.has(first.type))) {
    spliceRun(children, firstIndex, firstIndex, expansion)
    return true
  }
  return spliceInChildren(first, expansion)
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

/** Several expansions on one range share one place in the text: the active one. */
function visibleExpansions(expansions: ExpansionNode[]): ExpansionNode[] {
  const visible: ExpansionNode[] = []
  for (const node of expansions) {
    if (visible.some((other) => isSameRange(other, node))) continue
    const active = activeExpansion(expansions.filter((other) => isSameRange(other, node)))
    if (active) visible.push(active)
  }
  return visible.sort((a, b) => a.start - b.start)
}

/**
 * Parses `source` and splices every anchored expansion into the tree as an
 * `expansion` node between split text fragments. Each remaining text node is
 * converted to a `sourcedText` node carrying its absolute source offset.
 */
export function prepareMarkdownTree(source: string, expansions: ExpansionNode[]): MarkdownNode {
  const tree = parseMarkdown(source)
  for (const expansion of visibleExpansions(expansions)) spliceInChildren(tree, expansion)
  markSourceText(tree)
  return tree
}
