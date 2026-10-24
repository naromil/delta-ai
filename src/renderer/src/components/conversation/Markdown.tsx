/**
 * Markdown renderer for turn content and expansion answers.
 *
 * Pipeline: remark parse (+GFM) → splice expansion nodes by source offset →
 * mdast-util-to-hast (custom handlers for expansion + sourced text) →
 * hast-util-to-jsx-runtime with a React component map.
 *
 * Two output modes:
 * - `inline: false` renders real block elements (p, ul, li, pre, table, …).
 * - `inline: true` maps every block construct to a `<span>` with a `md-*`
 *   class, so an expansion answer can live inside the frame `<span>` without
 *   invalid nesting.
 */
import { createContext, useContext, useMemo } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { toHast } from 'mdast-util-to-hast'
import type { Handlers } from 'mdast-util-to-hast'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import type { Root as HastRoot } from 'hast'
import type { Root as MdastRoot } from 'mdast'
import type { ExpansionNode } from '../../../../shared/rich-text'
import { EXPANSION_NODE, SOURCED_TEXT, prepareMarkdownTree } from '../../lib/markdown'
import type { MarkdownNode } from '../../lib/markdown'

const EXPANSION_ELEMENT = 'expansion-frame'

export interface MarkdownActions {
  onFold: (id: number) => void
  onUnfold: (id: number) => void
}

interface ExpansionRenderContext extends MarkdownActions {
  nodes: ReadonlyMap<number, ExpansionNode>
  renderExpansion: (node: ExpansionNode) => React.ReactNode
}

const ExpansionRenderContext = createContext<ExpansionRenderContext | null>(null)

interface ExpansionSlotProps {
  'data-expansion-id'?: number
}

function ExpansionSlot(props: ExpansionSlotProps): React.ReactNode {
  const context = useContext(ExpansionRenderContext)
  if (!context) return null
  const id = props['data-expansion-id']
  const node = typeof id === 'number' ? context.nodes.get(id) : undefined
  if (!node) return null
  return context.renderExpansion(node)
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
  title?: string
  children?: React.ReactNode
}

const SAFE_PROTOCOL = /^(?:https?:|mailto:)/i

/** Model output is untrusted: only absolute web/mail URLs may become links. */
function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined
  const value = href.trim()
  return SAFE_PROTOCOL.test(value) ? value : undefined
}

/**
 * Rendered as a real anchor, but never navigates the app window. Unsafe
 * schemes (`javascript:`, `data:`, `file:`) degrade to plain text.
 */
function Anchor({ href, title, children }: AnchorProps): React.JSX.Element {
  const url = safeHref(href)
  if (!url) return <span className="md-link">{children}</span>
  return (
    <a
      className="md-link"
      href={url}
      title={title ?? url}
      rel="noopener noreferrer"
      target="_blank"
      onClick={(event) => event.preventDefault()}
    >
      {children}
    </a>
  )
}

const INLINE_COMPONENTS: Record<string, React.ComponentType<never>> = {
  [EXPANSION_ELEMENT]: ExpansionSlot as React.ComponentType<never>,
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
  img: ImageFallback as React.ComponentType<never>,
  a: Anchor as React.ComponentType<never>
}

function createHandlers(source: string): Handlers {
  return {
    [SOURCED_TEXT]: (_state, node: MarkdownNode) => ({
      type: 'element',
      tagName: 'span',
      properties: { 'data-src': node.src ?? 0 },
      children: [{ type: 'text', value: node.value ?? '' }]
    }),
    [EXPANSION_NODE]: (_state, node: MarkdownNode) => ({
      type: 'element',
      tagName: EXPANSION_ELEMENT,
      properties: { 'data-expansion-id': node.id },
      children: []
    }),
    inlineCode: (_state, node: MarkdownNode) => {
      const offset = node.position?.start.offset
      const ticks =
        typeof offset === 'number' ? (source.slice(offset).match(/^`+/) ?? [''])[0].length : 1
      return {
        type: 'element',
        tagName: 'code',
        properties: typeof offset === 'number' ? { 'data-src': offset + ticks } : {},
        children: [{ type: 'text', value: node.value ?? '' }]
      }
    }
  } as unknown as Handlers
}

function renderMarkdown(
  source: string,
  expansions: ExpansionNode[],
  inline: boolean
): React.ReactNode {
  const tree = prepareMarkdownTree(source, expansions)
  const hast = toHast(tree as unknown as MdastRoot, {
    handlers: createHandlers(source)
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
  renderExpansion: (node: ExpansionNode) => React.ReactNode
}

function Markdown({
  source,
  expansions,
  inline = false,
  onFold,
  onUnfold,
  renderExpansion
}: MarkdownProps): React.JSX.Element {
  const context = useMemo<ExpansionRenderContext>(
    () => ({
      nodes: new Map(expansions.map((node): [number, ExpansionNode] => [node.id, node])),
      onFold,
      onUnfold,
      renderExpansion
    }),
    [expansions, onFold, onUnfold, renderExpansion]
  )

  const body = useMemo(
    () => renderMarkdown(source, expansions, inline),
    [source, expansions, inline]
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
