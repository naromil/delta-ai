/**
 * Syntax highlighting for fenced code. Highlighting only wraps the code in
 * `hljs-*` spans: the concatenated text is exactly the input, so the Copy button
 * and every markdown source offset are unaffected.
 */
import { common, createLowlight } from 'lowlight'
import type { ElementContent } from 'hast'

/** Re-highlighting runs on every streamed chunk; huge blocks stay plain. */
const MAX_HIGHLIGHT_LENGTH = 20_000

const lowlight = createLowlight(common)

export function highlightCode(code: string, language: string | undefined): ElementContent[] {
  const plain: ElementContent[] = [{ type: 'text', value: code }]
  const name = language?.toLowerCase()
  if (!name || code.length > MAX_HIGHLIGHT_LENGTH || !lowlight.registered(name)) return plain
  try {
    return lowlight.highlight(name, code).children as ElementContent[]
  } catch {
    return plain
  }
}
