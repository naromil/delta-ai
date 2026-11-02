import { buildSuggestTermsUserMessage, SUGGEST_TERMS_SYSTEM_PROMPT } from '../shared/prompts'
import { parseSuggestedTerms } from '../shared/suggested-terms'
import { loadAppSettings, resolveRole } from './config'
import { memoriesDir, readAutoLoadedMemories } from './memory/store'
import { callProvider } from './provider'

/** Shorter answers rarely hold a term worth a paid request. */
const MIN_ANSWER_LENGTH = 200
const MAX_ANSWER_LENGTH = 12_000
const SUGGEST_TIMEOUT_MS = 30_000

/**
 * Asks the curator's model which terms in an answer look new to this user. It
 * judges only from the auto-loaded notes, so it stays silent until they exist.
 * Decoration must never surface an error: every failure is simply no suggestions.
 */
export async function suggestTermsForAnswer(answer: unknown): Promise<string[]> {
  if (typeof answer !== 'string' || answer.trim().length < MIN_ANSWER_LENGTH) return []
  try {
    if (!loadAppSettings().suggestTerms || !resolveRole('kb-maintenance')) return []
    const notes = readAutoLoadedMemories(memoriesDir())
    if (notes.length === 0) return []

    const reply = await callProvider(
      [
        { role: 'system', content: SUGGEST_TERMS_SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildSuggestTermsUserMessage(notes, answer.slice(0, MAX_ANSWER_LENGTH))
        }
      ],
      'kb-maintenance',
      AbortSignal.timeout(SUGGEST_TIMEOUT_MS)
    )
    return parseSuggestedTerms(reply, answer)
  } catch (err) {
    console.warn('Could not suggest terms for this answer:', err)
    return []
  }
}
