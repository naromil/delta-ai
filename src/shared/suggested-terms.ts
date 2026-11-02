/** The most terms one answer may underline: more would read as noise. */
export const MAX_SUGGESTED_TERMS = 5

const MAX_TERM_LENGTH = 60

/**
 * Reads the model's reply defensively: it must hold a JSON array of strings, and
 * a term counts only if it literally occurs in the answer, since that is the
 * only place it can be underlined.
 */
export function parseSuggestedTerms(reply: string, answer: string): string[] {
  const match = reply.match(/\[[\s\S]*\]/)
  if (!match) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const haystack = answer.toLowerCase()
  const seen = new Set<string>()
  const terms: string[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'string') continue
    const term = entry.trim()
    const key = term.toLowerCase()
    if (term === '' || term.length > MAX_TERM_LENGTH || seen.has(key)) continue
    if (!haystack.includes(key)) continue
    seen.add(key)
    terms.push(term)
  }
  return terms.slice(0, MAX_SUGGESTED_TERMS)
}
