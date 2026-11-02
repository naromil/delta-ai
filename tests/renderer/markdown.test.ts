import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ExpansionNode } from '../../src/shared/rich-text'
import Markdown from '../../src/renderer/src/components/conversation/Markdown'
import ExpansionFrame from '../../src/renderer/src/components/conversation/ExpansionFrame'
import {
  anchoredRange,
  isAnchoredRange,
  isPlainMarkdown,
  suggestedTermRanges
} from '../../src/renderer/src/lib/markdown'

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
      renderExpansion: (node: ExpansionNode, group: ExpansionNode[]) =>
        createElement(ExpansionFrame, {
          node,
          group,
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

/**
 * Opening flow-content tags that would be invalid inside the frame `<span>`.
 * Phrasing content (`span`, `code`, `strong`, `em`, `del`, `a`, `input`,
 * `button`, `br`) is intentionally allowed.
 */
const BLOCK_TAG =
  /<(div|p|ul|ol|li|pre|table|thead|tbody|tfoot|tr|td|th|h[1-6]|blockquote|section|article|aside|header|footer|main|nav|figure|figcaption|dl|dt|dd|details|summary|hr|form|fieldset|iframe|video|audio|canvas|svg)(\s|>)/

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
    const answer = [
      '**bold** tail',
      '',
      '- item one',
      '- item two',
      '- [ ] task',
      '',
      '```',
      'code line',
      '```',
      '',
      '> outer',
      '>',
      '> > inner',
      '',
      '![alt text](https://example.com/x.png)',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '---'
    ].join('\n')
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
    expect(frame).toContain('md-quote')
    expect(frame).toContain('md-hr')
    expect(frame).toContain('md-table')
    expect(frame).toContain('md-img')
    expect(frame).toContain('checkbox')
    expect(frame).not.toContain('<img')
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
    expect(markup).toContain('>Remove</button>')
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

const textOf = (html: string): string => html.replace(/<[^>]+>/g, '')

describe('links', () => {
  it('renders web links as external anchors that show the real URL', () => {
    const html = renderMarkdown('[docs](https://example.com/a "Totally safe")')
    expect(html).toContain('href="https://example.com/a"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('title="https://example.com/a"')
    expect(html).not.toContain('Totally safe')
  })

  it.each(['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'mailto:a@b.c'])(
    'degrades %s to plain text',
    (url) => {
      const html = renderMarkdown(`[click](${url})`)
      expect(html).not.toContain('<a ')
      expect(html).toContain('click')
    }
  )
})

describe('syntax highlighting', () => {
  it('wraps tokens of a known language in hljs spans', () => {
    const html = renderMarkdown('```ts\nconst a = 1\n```')
    expect(html).toContain('hljs-keyword')
    expect(html).toContain('language-ts')
  })

  it('leaves the code text unchanged, so Copy and offsets are unaffected', () => {
    const code = 'function add(a, b) {\n  return a + b // sum\n}'
    expect(textOf(renderMarkdown('```js\n' + code + '\n```'))).toContain(code)
    expect(renderMarkdown('```js\n' + code + '\n```')).not.toContain('data-src')
  })

  it('renders an unknown or missing language as plain text', () => {
    expect(renderMarkdown('```nosuchlang\nconst a = 1\n```')).not.toContain('hljs-')
    expect(renderMarkdown('```\nconst a = 1\n```')).not.toContain('hljs-')
  })

  it('keeps data-src anchors of the surrounding text exact', () => {
    const source = 'before\n\n```ts\nconst a = 1\n```\n\nafter'
    const html = renderMarkdown(source)
    expect(html).toContain(`data-src="${source.indexOf('after')}"`)
    expect(isAnchoredRange(source, { start: source.indexOf('after'), end: source.length })).toBe(
      true
    )
    expect(
      isAnchoredRange(source, { start: source.indexOf('const'), end: source.indexOf(' =') })
    ).toBe(false)
  })
})

describe('math', () => {
  it.each([
    ['$x^2$', false],
    ['\\(x^2\\)', false],
    ['$$x^2$$', true],
    ['\\[x^2\\]', true],
    ['$$\nx^2\n$$', true],
    ['\\[\nx^2\n\\]', true]
  ])('renders %s (display: %s)', (source, display) => {
    const html = renderMarkdown(source)
    expect(html).toContain('class="katex')
    expect(html.includes('md-math-display')).toBe(display)
  })

  it('keeps offsets of text after a formula exact, for every delimiter', () => {
    for (const source of ['Before $x^2$ after', 'Before \\(x^2\\) after', '\\[x^2\\]\n\n after']) {
      const start = source.lastIndexOf('after')
      const html = renderMarkdown(source)
      expect(html).toContain('class="katex')
      expect(html).toMatch(new RegExp(`data-src="(${start}|${start - 1})"`))
      expect(isAnchoredRange(source, { start, end: source.length })).toBe(true)
    }
  })

  it('refuses to anchor an expansion inside a formula', () => {
    const source = 'Before $x^2$ after'
    expect(isAnchoredRange(source, { start: 8, end: 9 })).toBe(false)
  })

  it('splices an expansion after a formula at the right place', () => {
    const source = 'Given \\(x\\) the value holds'
    const start = source.indexOf('value')
    const html = renderMarkdown(source, [
      expansion({ id: 1, start, end: start + 5, originalText: 'value' })
    ])
    expect(html).toContain('class="katex')
    expect(html).toContain('data-expansion-id="1"')
  })

  it.each(['$5 and $10', 'from $5-$10 today', 'costs $100 (about $120)', 'US$5 or CA$7'])(
    'leaves the prose %s as anchored text',
    (source) => {
      expect(renderMarkdown(source)).not.toContain('katex')
      expect(textOf(renderMarkdown(source))).toBe(source)
      expect(isAnchoredRange(source, { start: 0, end: source.length })).toBe(true)
    }
  )

  it('does not treat backslash delimiters inside code as math', () => {
    expect(renderMarkdown('`\\(x\\)`')).toContain('\\(x\\)')
    expect(renderMarkdown('`\\(x\\)`')).not.toContain('katex')
    expect(renderMarkdown('```\n\\[x\\]\n```')).not.toContain('katex')
  })

  it('leaves an inline escaped citation alone', () => {
    expect(renderMarkdown('see \\[1\\] for more')).not.toContain('katex')
  })

  it('renders broken TeX as an error instead of throwing', () => {
    expect(renderMarkdown('$\\frac{$')).toContain('katex-error')
  })

  it('disables TeX commands that could carry a URL', () => {
    const html = renderMarkdown('$\\href{javascript:alert(1)}{x}$')
    expect(html).not.toContain('href=')
    expect(html).not.toContain('<a ')
  })

  it('stays inside span-only markup in an inline frame', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        source: '$$x^2$$',
        expansions: [],
        inline: true,
        onFold: noop,
        onUnfold: noop,
        renderExpansion: () => null
      })
    )
    expect(html).toContain('md-math-display')
    expect(html).not.toMatch(/<(div|p)\b/)
  })
})

describe('wider selections', () => {
  it('widens an edge inside bold, code or a link to the whole element', () => {
    const source = 'Try **bold** here'
    const start = source.indexOf('bold')
    expect(anchoredRange(source, { start: 0, end: start + 2 })).toEqual({
      start: 0,
      end: source.indexOf(' here'),
      kind: 'inline'
    })
    expect(anchoredRange('a `code` b', { start: 3, end: 5 })).toEqual({
      start: 2,
      end: 8,
      kind: 'atom'
    })
    const linked = 'see [the docs](https://x.dev) now'
    expect(anchoredRange(linked, { start: 0, end: 7 })?.end).toBe(linked.indexOf(' now'))
  })

  it('keeps a selection inside one text node exact', () => {
    expect(anchoredRange('Try **bold** here', { start: 6, end: 8 })).toEqual({
      start: 6,
      end: 8,
      kind: 'text'
    })
  })

  it('refuses a selection across blocks or table cells', () => {
    expect(anchoredRange('one\n\ntwo', { start: 0, end: 8 })).toBeNull()
    expect(anchoredRange('- one\n- two', { start: 2, end: 11 })).toBeNull()
    const table = '| a | b |\n| - | - |\n| c | d |'
    expect(
      anchoredRange(table, { start: table.indexOf('c'), end: table.indexOf('d') + 1 })
    ).toBeNull()
  })

  it('refuses to cut through a text node whose offsets do not map to the source', () => {
    const source = 'a \\* b **c** d'
    expect(anchoredRange(source, { start: 2, end: source.indexOf(' d') })).toBeNull()
  })

  it('targets a whole code block or formula as one atom', () => {
    const code = 'Intro\n\n```js\nconst a = 1\n\nconst b = 2\n```\n\nOutro'
    const inside = code.indexOf('const b')
    expect(anchoredRange(code, { start: inside, end: inside + 5 })).toEqual({
      start: code.indexOf('```js'),
      end: code.lastIndexOf('```') + 3,
      kind: 'atom'
    })
    const math = 'Intro\n\n$$\ny^2\n$$\n'
    const block = anchoredRange(math, { start: math.indexOf('y^2'), end: math.indexOf('y^2') + 1 })
    expect(block?.kind).toBe('atom')
  })

  it('renders a frame across bold in place of the covered run, keeping the rest', () => {
    const source = 'Try **bold** here now'
    const end = source.indexOf(' now')
    const markup = renderMarkdown(source, [
      expansion({ id: 8, start: 0, end, originalText: source.slice(0, end), answer: 'answered' })
    ])
    expect(markup).toContain('answered')
    expect(markup).not.toContain('<strong>')
    expect(markup).toContain(`data-src="${end}"`)
  })

  it('renders a frame on a code block and keeps the code visible beside its answer', () => {
    const fence = '```js\nconst a = 1\n```'
    const source = `Intro\n\n${fence}\n\nOutro`
    const start = source.indexOf(fence)
    const markup = renderMarkdown(source, [
      expansion({
        id: 9,
        start,
        end: start + fence.length,
        originalText: fence,
        answer: 'declares a'
      })
    ])
    const frame = markup.slice(markup.indexOf('data-expansion-id="9"'))
    expect(frame).toContain('frame-source')
    expect(frame).toContain('md-pre')
    expect(frame).toContain('declares a')
    // Display-only code must not look like a selection target with snippet offsets.
    const answerAnchor = frame.lastIndexOf('<span data-src', frame.indexOf('declares a'))
    expect(frame.slice(0, answerAnchor)).not.toMatch(/data-(src|atom-start)/)
  })

  it('marks code and formulas with their source range for the selection mapper', () => {
    const markup = renderMarkdown('```js\nx\n```\n\n$y$')
    expect(markup).toContain('data-atom-start="0"')
    expect(markup).toMatch(/md-math[^>]*data-atom-start="\d+"/)
  })

  it('shows a folded pill across bold rendered, with no anchors inside it', () => {
    const originalText = 'Try **bold**'
    const markup = renderMarkdown('Try **bold** here', [
      expansion({ id: 3, start: 0, end: originalText.length, originalText, folded: true })
    ])
    const nextAnchor = markup.lastIndexOf('<span data-src', markup.indexOf(' here'))
    const pill = markup.slice(markup.indexOf('class="queried"'), nextAnchor)
    expect(pill).toContain('<strong>')
    expect(pill).not.toContain('data-src')
    expect(pill).toContain('aria-label="Expand Try bold"')
  })

  it('tells plain slices from ones that need rendering', () => {
    expect(isPlainMarkdown('plain words')).toBe(true)
    expect(isPlainMarkdown('snake_case_name')).toBe(true)
    expect(isPlainMarkdown('some **bold**')).toBe(false)
    expect(isPlainMarkdown('`code`')).toBe(false)
  })
})

describe('several expansions on one range', () => {
  const group = [
    expansion({ id: 1, start: 7, end: 12, folded: true, answer: 'first answer' }),
    expansion({ id: 2, start: 7, end: 12, prompt: 'Why is this so?', answer: 'second answer' })
  ]

  it('renders only the open one, with a way to reach the others', () => {
    const markup = renderToStaticMarkup(
      createElement(Markdown, {
        source: 'Before alpha after',
        expansions: group,
        onFold: noop,
        onUnfold: noop,
        renderExpansion: (node: ExpansionNode, nodes: ExpansionNode[]) =>
          createElement(ExpansionFrame, {
            node,
            group: nodes,
            onFold: noop,
            onUnfold: noop,
            onPickAnswer: noop
          })
      })
    )
    expect(markup).toContain('second answer')
    expect(markup).not.toContain('first answer')
    expect(markup).toContain('>2 answers</button>')
    expect(markup.match(/data-expansion-id/g)).toHaveLength(1)
  })

  it('shows one pill with a count when all are folded', () => {
    const markup = renderMarkdown(
      'Before alpha after',
      group.map((node) => ({ ...node, folded: true }))
    )
    expect(markup.match(/class="queried"/g)).toHaveLength(1)
    expect(markup).toContain('queried-count')
  })
})

describe('frame actions and question', () => {
  it('offers regenerate, ask, copy and remove on a finished frame, with its question', () => {
    const markup = renderToStaticMarkup(
      createElement(ExpansionFrame, {
        node: expansion({ id: 1, answer: 'an answer', prompt: 'Why is this so?' }),
        onFold: noop,
        onUnfold: noop,
        onRetry: noop,
        onDismiss: noop,
        onAskAnother: noop
      })
    )
    expect(markup).toContain('frame-question')
    expect(markup).toContain('Why is this so?')
    for (const label of ['Regenerate', 'Ask…', 'Copy', 'Remove']) {
      expect(markup).toContain(`>${label}</button>`)
    }
  })

  it('hides the question for a default expand and offers only Remove while waiting', () => {
    const markup = renderToStaticMarkup(
      createElement(ExpansionFrame, {
        node: expansion({ id: 1, status: 'loading', prompt: '   ' }),
        onFold: noop,
        onUnfold: noop,
        onRetry: noop,
        onDismiss: noop,
        onAskAnother: noop
      })
    )
    expect(markup).not.toContain('frame-question')
    expect(markup).toContain('>Remove</button>')
    expect(markup).not.toContain('>Regenerate</button>')
    expect(markup).not.toContain('>Copy</button>')
  })

  it('keeps the question out of a folded pill except as its tooltip', () => {
    const markup = renderMarkdown('Before alpha after', [
      expansion({ id: 3, start: 7, end: 12, folded: true, prompt: 'Why is this so?' })
    ])
    expect(markup).not.toContain('>Why is this so?<')
    expect(markup).toContain('title="Why is this so?"')
  })
})

describe('suggested terms', () => {
  const render = (source: string, terms: string[], expansions: ExpansionNode[] = []): string =>
    renderToStaticMarkup(
      createElement(Markdown, {
        source,
        expansions,
        suggestedTerms: terms,
        onFold: noop,
        onUnfold: noop,
        renderExpansion: () => null
      })
    )

  it('underlines the first whole-word match only, keeping exact offsets', () => {
    const source = 'A monad wraps. Monads and a monad again.'
    const [range] = suggestedTermRanges(source, ['monad'], [])
    expect(source.slice(range.start, range.end)).toBe('monad')
    const markup = render(source, ['monad'])
    expect(markup.match(/suggested-term/g)).toHaveLength(1)
    expect(markup).toContain(`data-src="${range.start}"`)
    expect(markup).toContain(`data-src="${range.end}"`)
  })

  it('never marks code, escaped text or an expanded range', () => {
    expect(suggestedTermRanges('use `monad` here', ['monad'], [])).toEqual([])
    expect(
      suggestedTermRanges(
        'a monad',
        ['monad'],
        [expansion({ id: 1, start: 2, end: 7, originalText: 'monad' })]
      )
    ).toEqual([])
  })

  it('does not move the underline to a later mention once a term is expanded', () => {
    const expanded = expansion({ id: 1, start: 2, end: 7, originalText: 'monad' })
    expect(suggestedTermRanges('a monad and a monad', ['monad'], [expanded])).toEqual([])
  })

  it('caps how many terms one answer can underline', () => {
    const terms = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']
    expect(suggestedTermRanges(terms.join(' '), terms, [])).toHaveLength(5)
  })

  it('treats a term as literal text, not a pattern', () => {
    expect(suggestedTermRanges('see C++ here', ['C++'], [])).toHaveLength(1)
    expect(suggestedTermRanges('see Cxx here', ['C.*'], [])).toEqual([])
  })
})
