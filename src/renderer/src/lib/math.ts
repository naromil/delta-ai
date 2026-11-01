import katex from 'katex'

/**
 * Renders model-written TeX to HTML. `trust: false` keeps `\href`, `\includegraphics`
 * and friends disabled, so the output carries no links, URLs or scripts and is safe
 * to inject. Bad TeX renders as KaTeX's inline error rather than throwing mid-stream.
 */
export function renderMath(tex: string, display: boolean): string {
  return katex.renderToString(tex, {
    displayMode: display,
    throwOnError: false,
    trust: false,
    strict: 'ignore',
    output: 'htmlAndMathml'
  })
}
