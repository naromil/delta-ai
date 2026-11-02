/**
 * Markdown renderer for turn content and expansion answers.
 *
 * Pipeline: remark parse (+GFM, math) → splice expansion nodes by source offset →
 * mdast-util-to-hast (custom handlers for expansion + sourced text) →
 * hast-util-to-jsx-runtime with a React component map.
 *
 * Two output modes:
 * - `inline: false` renders real block elements (p, ul, li, pre, table, …).
 * - `inline: true` maps every block construct to a `<span>` with a `md-*`
 *   class, so an expansion answer can live inside the frame `<span>` without
 *   invalid nesting.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { toHast } from 'mdast-util-to-hast'
import type { Handlers } from 'mdast-util-to-hast'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import type { Element, Root as HastRoot } from 'hast'
import type { Root as MdastRoot } from 'mdast'
import type { ExpansionNode } from '../../../../shared/rich-text'
import { isSameRange } from '../../../../shared/rich-text'
import { highlightCode } from '../../lib/highlight'
import { renderMath } from '../../lib/math'
import {
  EXPANSION_NODE,
  SOURCED_TEXT,
  isDisplayMath,
  prepareMarkdownTree,
  suggestedTermRanges
} from '../../lib/markdown'
import type { MarkdownNode } from '../../lib/markdown'

const EXPANSION_ELEMENT = 'expansion-frame'
const MATH_ELEMENT = 'math-formula'

export interface MarkdownActions {
  onFold: (id: number) => void
  onUnfold: (id: number) => void
}

/** `group` is every expansion on the node's range, including the node. */
export type RenderExpansion = (node: ExpansionNode, group: ExpansionNode[]) => React.ReactNode

interface ExpansionRenderContext extends MarkdownActions {
  nodes: ReadonlyMap<number, { node: ExpansionNode; group: ExpansionNode[] }>
  renderExpansion: RenderExpansion
}

const ExpansionRenderContext = createContext<ExpansionRenderContext | null>(null)

interface ExpansionSlotProps {
  'data-expansion-id'?: number
}

function ExpansionSlot(props: ExpansionSlotProps): React.ReactNode {
  const context = useContext(ExpansionRenderContext)
  if (!context) return null
  const id = props['data-expansion-id']
  const entry = typeof id === 'number' ? context.nodes.get(id) : undefined
  if (!entry) return null
  return context.renderExpansion(entry.node, entry.group)
}

interface InlineElementProps {
  children?: React.ReactNode
  style?: React.CSSProperties
}

function inlineElement(className: string): (props: InlineElementProps) => React.JSX.Element {
  return function InlineElement({ children, style }: InlineElementProps): React.JSX.Element {
    return (
      <span className={className} style={style}>
        {children}
      </span>
    )
  }
}

interface ImageFallbackProps {
  alt?: string
  src?: string
}

/** Images render as their alt text: no remote fetch from the renderer. */
function ImageFallback({ alt, src }: ImageFallbackProps): React.JSX.Element {
  return <span className="md-img">{alt || src || ''}</span>
}

type JsxOptions = Parameters<typeof toJsxRuntime>[1]

interface AnchorProps {
  href?: string
  children?: React.ReactNode
}

/** Matches `isSafeExternalUrl` in `window-guards.ts`, the check that actually opens a link. */
const SAFE_PROTOCOL = /^https?:/i

/** Model output is untrusted: only absolute web URLs may become links. */
function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined
  const value = href.trim()
  return SAFE_PROTOCOL.test(value) ? value : undefined
}

/**
 * `target="_blank"` routes the click through `setWindowOpenHandler`, which hands
 * the URL to the system browser, so the app window never navigates. The tooltip
 * always shows the real URL: a model-written title or label must not disguise
 * the destination. Other schemes (`javascript:`, `data:`, `file:`, `mailto:`)
 * degrade to plain text.
 */
function Anchor({ href, children }: AnchorProps): React.JSX.Element {
  const url = safeHref(href)
  if (!url) return <span className="md-link">{children}</span>
  return (
    <a className="md-link" href={url} title={url} rel="noopener noreferrer" target="_blank">
      {children}
    </a>
  )
}

interface MathFormulaProps {
  'data-tex'?: string
  'data-display'?: string
  'data-atom-start'?: number
  'data-atom-end'?: number
}

function MathFormula(props: MathFormulaProps): React.JSX.Element {
  const tex = props['data-tex'] ?? ''
  const display = props['data-display'] === 'true'
  const html = useMemo(() => renderMath(tex, display), [tex, display])
  return (
    <span
      className={display ? 'md-math md-math-display' : 'md-math'}
      data-atom-start={props['data-atom-start']}
      data-atom-end={props['data-atom-end']}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

interface CodeBlockProps {
  children?: React.ReactNode
}

/** Block-mode fenced code with its own Copy button, so copying needs no manual selection. */
function CodeBlock({ children }: CodeBlockProps): React.JSX.Element {
  const preRef = useRef<HTMLPreElement>(null)
  const timerRef = useRef<number | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  const handleCopy = async (): Promise<void> => {
    // mdast-util-to-hast appends one newline to every fenced block.
    const text = (preRef.current?.textContent ?? '').replace(/\n$/, '')
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      return
    }
    setCopied(true)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setCopied(false)
    }, 1500)
  }

  return (
    <div className="md-codeblock">
      <pre ref={preRef}>{children}</pre>
      <button
        type="button"
        className="md-codeblock-copy"
        onClick={() => void handleCopy()}
        aria-label="Copy code"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

const INLINE_COMPONENTS: Record<string, React.ComponentType<never>> = {
  [EXPANSION_ELEMENT]: ExpansionSlot as React.ComponentType<never>,
  [MATH_ELEMENT]: MathFormula as React.ComponentType<never>,
  p: inlineElement('md-p') as React.ComponentType<never>,
  h1: inlineElement('md-h1') as React.ComponentType<never>,
  h2: inlineElement('md-h2') as React.ComponentType<never>,
  h3: inlineElement('md-h3') as React.ComponentType<never>,
  h4: inlineElement('md-h4') as React.ComponentType<never>,
  h5: inlineElement('md-h5') as React.ComponentType<never>,
  h6: inlineElement('md-h6') as React.ComponentType<never>,
  ul: inlineElement('md-list md-ul') as React.ComponentType<never>,
  ol: inlineElement('md-list md-ol') as React.ComponentType<never>,
  li: inlineElement('md-li') as React.ComponentType<never>,
  blockquote: inlineElement('md-quote') as React.ComponentType<never>,
  pre: inlineElement('md-pre') as React.ComponentType<never>,
  table: inlineElement('md-table') as React.ComponentType<never>,
  thead: inlineElement('md-table-head') as React.ComponentType<never>,
  tbody: inlineElement('md-table-body') as React.ComponentType<never>,
  tfoot: inlineElement('md-table-foot') as React.ComponentType<never>,
  tr: inlineElement('md-row') as React.ComponentType<never>,
  td: inlineElement('md-cell') as React.ComponentType<never>,
  th: inlineElement('md-cell') as React.ComponentType<never>,
  hr: inlineElement('md-hr') as React.ComponentType<never>,
  section: inlineElement('md-section') as React.ComponentType<never>,
  img: ImageFallback as React.ComponentType<never>,
  a: Anchor as React.ComponentType<never>
}

const BLOCK_COMPONENTS: Record<string, React.ComponentType<never>> = {
  [EXPANSION_ELEMENT]: ExpansionSlot as React.ComponentType<never>,
  [MATH_ELEMENT]: MathFormula as React.ComponentType<never>,
  pre: CodeBlock as React.ComponentType<never>,
  img: ImageFallback as React.ComponentType<never>,
  a: Anchor as React.ComponentType<never>
}

/**
 * Source range of a code block or formula, read back by the selection mapper:
 * their rendered text does not map to source offsets, so they are targeted whole.
 */
function atomProperties(node: MarkdownNode, anchored: boolean): Record<string, number> {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (!anchored || typeof start !== 'number' || typeof end !== 'number') return {}
  return { 'data-atom-start': start, 'data-atom-end': end }
}

function mathElement(tex: string, display: boolean, atom: Record<string, number>): Element {
  return {
    type: 'element',
    tagName: MATH_ELEMENT,
    properties: { 'data-tex': tex, 'data-display': String(display), ...atom },
    children: []
  }
}

function createHandlers(source: string, anchored: boolean): Handlers {
  return {
    [SOURCED_TEXT]: (_state, node: MarkdownNode) => ({
      type: 'element',
      tagName: 'span',
      properties: {
        ...(anchored ? { 'data-src': node.src ?? 0 } : {}),
        ...(node.suggested
          ? {
              className: ['suggested-term'],
              'data-suggested': 'true',
              role: 'button',
              tabIndex: 0,
              title: 'Click to expand'
            }
          : {})
      },
      children: [{ type: 'text', value: node.value ?? '' }]
    }),
    [EXPANSION_NODE]: (_state, node: MarkdownNode) => ({
      type: 'element',
      tagName: EXPANSION_ELEMENT,
      properties: { 'data-expansion-id': node.id },
      children: []
    }),
    inlineMath: (_state, node: MarkdownNode) =>
      mathElement(node.value ?? '', isDisplayMath(source, node), atomProperties(node, anchored)),
    math: (_state, node: MarkdownNode) =>
      mathElement(node.value ?? '', true, atomProperties(node, anchored)),
    code: (_state, node: MarkdownNode) => {
      const language = node.lang?.split(/\s+/)[0]
      return {
        type: 'element',
        tagName: 'pre',
        properties: {},
        children: [
          {
            type: 'element',
            tagName: 'code',
            properties: {
              ...(language ? { className: [`language-${language}`] } : {}),
              ...atomProperties(node, anchored)
            },
            // Same trailing newline as the default handler; CodeBlock's Copy strips it.
            children: highlightCode(node.value ? `${node.value}\n` : '', language)
          }
        ]
      }
    },
    inlineCode: (_state, node: MarkdownNode) => {
      const offset = node.position?.start.offset
      const ticks =
        typeof offset === 'number' ? (source.slice(offset).match(/^`+/) ?? [''])[0].length : 1
      return {
        type: 'element',
        tagName: 'code',
        properties: anchored && typeof offset === 'number' ? { 'data-src': offset + ticks } : {},
        children: [{ type: 'text', value: node.value ?? '' }]
      }
    }
  } as unknown as Handlers
}

function renderMarkdown(
  source: string,
  expansions: ExpansionNode[],
  inline: boolean,
  anchored: boolean,
  suggestedTerms: readonly string[]
): React.ReactNode {
  const suggested = suggestedTermRanges(source, suggestedTerms, expansions)
  const tree = prepareMarkdownTree(source, expansions, suggested)
  const hast = toHast(tree as unknown as MdastRoot, {
    handlers: createHandlers(source, anchored)
  }) as HastRoot
  const components = inline ? INLINE_COMPONENTS : BLOCK_COMPONENTS
  return toJsxRuntime(hast, {
    ...jsxRuntime,
    components: components as JsxOptions['components']
  } as JsxOptions) as React.ReactNode
}

export interface MarkdownProps extends MarkdownActions {
  source: string
  expansions: ExpansionNode[]
  inline?: boolean
  /**
   * `false` renders display-only text (a folded pill's original): offsets would be
   * relative to that snippet, so no element may look like a selection target.
   */
  anchored?: boolean
  suggestedTerms?: readonly string[]
  renderExpansion: RenderExpansion
}

const NO_TERMS: readonly string[] = []

function buildNodeEntries(
  expansions: ExpansionNode[]
): Map<number, { node: ExpansionNode; group: ExpansionNode[] }> {
  return new Map(
    expansions.map((node) => [
      node.id,
      { node, group: expansions.filter((other) => isSameRange(other, node)) }
    ])
  )
}

function Markdown({
  source,
  expansions,
  inline = false,
  anchored = true,
  suggestedTerms = NO_TERMS,
  onFold,
  onUnfold,
  renderExpansion
}: MarkdownProps): React.JSX.Element {
  const context = useMemo<ExpansionRenderContext>(
    () => ({
      nodes: buildNodeEntries(expansions),
      onFold,
      onUnfold,
      renderExpansion
    }),
    [expansions, onFold, onUnfold, renderExpansion]
  )

  const body = useMemo(
    () => renderMarkdown(source, expansions, inline, anchored, suggestedTerms),
    [source, expansions, inline, anchored, suggestedTerms]
  )

  return (
    <ExpansionRenderContext.Provider value={context}>
      {inline ? (
        <span className="markdown-inline">{body}</span>
      ) : (
        <div className="markdown-body">{body}</div>
      )}
    </ExpansionRenderContext.Provider>
  )
}

export default Markdown
