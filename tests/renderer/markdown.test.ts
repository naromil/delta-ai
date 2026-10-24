import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ExpansionNode } from '../../src/shared/rich-text'
import Markdown from '../../src/renderer/src/components/conversation/Markdown'
import ExpansionFrame from '../../src/renderer/src/components/conversation/ExpansionFrame'
import { isAnchoredRange } from '../../src/renderer/src/lib/markdown'

const noop = (): void => {}

interface FrameActions {
  onRetry?: (id: number) => void
  onDismiss?: (id: number) => void
}

function renderMarkdown(
  source: string,
  expansions: ExpansionNode[] = [],
  actions: FrameActions = {}
): string {
  return renderToStaticMarkup(
    createElement(Markdown, {
      source,
      expansions,
      onFold: noop,
      onUnfold: noop,
      renderExpansion: (node: ExpansionNode) =>
        createElement(ExpansionFrame, {
          node,
          onFold: noop,
          onUnfold: noop,
          onRetry: actions.onRetry,
          onDismiss: actions.onDismiss
        })
    })
  )
}

function expansion(overrides: Partial<ExpansionNode> & Pick<ExpansionNode, 'id'>): ExpansionNode {
  return {
    start: 0,
    end: 5,
    originalText: 'alpha',
    answer: '',
    status: 'done',
    folded: false,
    children: [],
    ...overrides
  }
}

/** Opening block-level tags that must never appear inside an expansion frame. */
const BLOCK_TAG = /<(div|p|ul|ol|li|pre|table|thead|tbody|tfoot|tr|td|th|h[1-6])(\s|>)/

describe('Markdown renderer', () => {
  it('renders headings, emphasis, code, lists, quotes, tables and rules', () => {
    const source = [
      '# Title',
      '',
      'Some **bold**, *italic* and `code`.',
      '',
      '- one',
      '- two',
      '',
      '```js',
      'const x = 1',
      '```',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '> quote',
      '',
      '---',
      ''
    ].join('\n')

    const markup = renderMarkdown(source)

    expect(markup).toContain('<h1')
    expect(markup).toContain('<strong')
    expect(markup).toContain('<em>')
    expect(markup).toContain('<code')
    expect(markup).toContain('<ul>')
    expect(markup).toContain('<li>')
    expect(markup).toContain('<pre>')
    expect(markup).toContain('<table>')
    expect(markup).toContain('<blockquote>')
    expect(markup).toContain('<hr')
  })

  it('annotates every text node with its absolute source offset', () => {
    const source = 'alpha **beta** gamma `delta`'
    const markup = renderMarkdown(source)
    const pattern = /<(?:span|code) data-src="(\d+)">([^<]*)<\/(?:span|code)>/g
    const hits = Array.from(markup.matchAll(pattern)).map((match) => ({
      offset: Number(match[1]),
      text: match[2]
    }))

    expect(hits.length).toBeGreaterThanOrEqual(4)
    hits.forEach((hit, index) => {
      if (index > 0) expect(hit.offset).toBeGreaterThan(hits[index - 1].offset)
      expect(source.slice(hit.offset, hit.offset + hit.text.length)).toBe(hit.text)
    })
  })

  it('renders an expansion frame with only inline-safe tags inside it', () => {
    const answer = '**bold** tail\n\n- item one\n- item two\n\n```\ncode line\n```'
    const source = 'Before alpha after'
    const markup = renderMarkdown(source, [
      expansion({ id: 7, start: 7, end: 12, originalText: 'alpha', answer })
    ])

    expect(markup).toContain('<p>')
    expect(markup).toContain('data-expansion-id="7"')

    const frame = markup.slice(markup.indexOf('data-expansion-id="7"'))
    expect(frame).not.toMatch(BLOCK_TAG)
    expect(frame).toContain('<strong')
    expect(frame).toContain('md-li')
    expect(frame).toContain('md-pre')
    // Frame text offsets are relative to the expansion answer (`bold` starts at 2).
    expect(frame).toContain('data-src="2"')
    expect(frame).toContain('data-src="17"')
  })

  it('renders nested frames inline-safe, with ids for both levels', () => {
    const child = expansion({
      id: 9,
      start: 0,
      end: 4,
      originalText: 'bold',
      answer: 'nested answer'
    })
    const parent = expansion({
      id: 8,
      start: 7,
      end: 12,
      originalText: 'alpha',
      answer: 'bold tail',
      children: [child]
    })
    const markup = renderMarkdown('Before alpha after', [parent])

    expect(markup).toContain('data-expansion-id="8"')
    expect(markup).toContain('data-expansion-id="9"')

    const frame = markup.slice(markup.indexOf('data-expansion-id="8"'))
    expect(frame).not.toMatch(BLOCK_TAG)
  })

  it('renders a folded expansion as its original text pill', () => {
    const markup = renderMarkdown('Before alpha after', [
      expansion({ id: 3, start: 7, end: 12, folded: true })
    ])

    expect(markup).toContain('class="queried"')
    expect(markup).toContain('data-expansion-id="3"')
    expect(markup).toContain('>alpha</span>')
  })

  it('anchors ranges only inside one markdown text node', () => {
    expect(isAnchoredRange('Try **bold** here', { start: 6, end: 10 })).toBe(true)
    expect(isAnchoredRange('- one\n- two', { start: 2, end: 5 })).toBe(true)
    // Spans two text nodes (`a` inside strong, ` b` outside): refused.
    expect(isAnchoredRange('**a** b', { start: 2, end: 6 })).toBe(false)
    // Inline code is a leaf `value`, not a text node.
    expect(isAnchoredRange('a `code` b', { start: 3, end: 7 })).toBe(false)
  })

  it('skips an expansion whose range is not inside one text node', () => {
    const markup = renderMarkdown('a **b**', [
      expansion({ id: 4, start: 2, end: 3, originalText: '*' })
    ])
    expect(markup).not.toContain('data-expansion-id')
  })

  it('renders an errored frame with its term, error and recovery actions', () => {
    const markup = renderMarkdown(
      'Before alpha after',
      [expansion({ id: 5, start: 7, end: 12, status: 'error', error: 'boom' })],
      { onRetry: noop, onDismiss: noop }
    )

    const frame = markup.slice(markup.indexOf('data-expansion-id="5"'))
    expect(frame).not.toMatch(BLOCK_TAG)
    expect(markup).toContain('frame-error')
    expect(markup).toContain('boom')
    expect(markup).toContain('frame-term')
    expect(markup).toContain('>Retry</button>')
    expect(markup).toContain('>Dismiss</button>')
    // Folding is still available: it restores the original text into the flow.
    expect(markup).toContain('fold-toggle')
  })

  it('renders a partially streamed answer next to the error', () => {
    const markup = renderMarkdown(
      'Before alpha after',
      [
        expansion({
          id: 6,
          start: 7,
          end: 12,
          status: 'error',
          error: 'connection lost',
          answer: 'partial **answer**'
        })
      ],
      { onRetry: noop, onDismiss: noop }
    )

    expect(markup).toContain('partial')
    expect(markup).toContain('<strong>')
    expect(markup).toContain('connection lost')
    expect(markup).toContain('>Retry</button>')
  })

  it('keeps http(s) links but degrades unsafe schemes to text', () => {
    const safe = renderMarkdown('[ok](https://example.com)')
    expect(safe).toContain('href="https://example.com"')
    expect(safe).toContain('rel="noopener noreferrer"')

    const unsafe = renderMarkdown('[x](javascript:evil)')
    expect(unsafe).not.toContain('href="javascript')
    expect(unsafe).toContain('md-link')
  })

  it('drops raw HTML instead of injecting it', () => {
    const markup = renderMarkdown('before <img src=x onerror="alert(1)"> after')
    expect(markup).not.toContain('onerror')
    expect(markup).not.toContain('<img')
  })

  it('renders streaming text that is still unclosed markdown', () => {
    const markup = renderMarkdown('partial **bo')
    expect(markup).toContain('partial')
    expect(markup).toContain('**bo')
  })
})
