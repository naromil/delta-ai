import type { ConversationMeta, ConversationRecord } from '../../shared/conversation'
import type { KbRunResult } from '../../shared/kb'
import { callProvider } from '../provider'
import { loadConversation, markConversationKbFed } from '../conversations'
import { buildKbAnalysisMessages, buildKbKeywordMessages, buildSingleMaterial } from './analysis'
import { mergeKeywords, parseKeywords, trimByCategory } from './keywords'
import { loadKbKeywords, loadKbPrompt, saveKbKeywords, saveKbPrompt } from './store'

export interface KbAnalysisOptions {
  /** Fold each processed conversation into the profile so it is not analyzed again. */
  markFed: boolean
  /** Aborts between conversations and mid-request, so a reset wins over a running pass. */
  signal?: AbortSignal
}

/**
 * Whether a record contains anything a preference model can learn from:
 * prose in any turn, or an expansion (the term the user drilled into is a
 * signal even when the surrounding text is blank).
 */
function hasLearningMaterial(record: ConversationRecord): boolean {
  return record.state.turns.some((turn) => turn.content.trim() !== '' || turn.expansions.length > 0)
}

/**
 * Folds conversation material into the learned prompt one conversation at a
 * time, persisting after each step so an interrupted run keeps its progress.
 *
 * Conversations that carry no learning signal — standalone look-ups and empty
 * records — are marked fed and skipped rather than being retried forever.
 */
export async function runKbAnalysis(
  metas: Array<Pick<ConversationMeta, 'id'>>,
  options: KbAnalysisOptions
): Promise<KbRunResult> {
  let currentPrompt = loadKbPrompt()
  let analyzed = 0

  for (const meta of metas) {
    if (options.signal?.aborted) break
    const record = await loadConversation(meta.id)
    if (!record) continue
    // The caller's list may predate the queue wait: a manual or automatic pass
    // that won the queue already folded this conversation in.
    if (options.markFed && record.kbFed) continue

    if (record.source === 'lookup' || !hasLearningMaterial(record)) {
      if (options.markFed) await markConversationKbFed(meta.id)
      continue
    }

    const messages = buildKbAnalysisMessages(currentPrompt, buildSingleMaterial(record))
    currentPrompt = await callProvider(messages, 'kb-maintenance', options.signal)
    saveKbPrompt(currentPrompt)
    if (options.markFed) await markConversationKbFed(meta.id)
    analyzed++
  }

  if (options.signal?.aborted || analyzed === 0) {
    return {
      newPrompt: currentPrompt,
      keywords: loadKbKeywords(),
      conversationsAnalyzed: 0
    }
  }

  const existingKeywords = loadKbKeywords()
  const rawKeywords = await callProvider(
    buildKbKeywordMessages(currentPrompt, existingKeywords),
    'kb-maintenance',
    options.signal
  )
  const trimmed = trimByCategory(mergeKeywords(existingKeywords, parseKeywords(rawKeywords)))
  saveKbKeywords(trimmed)

  return {
    newPrompt: currentPrompt,
    keywords: trimmed,
    conversationsAnalyzed: analyzed
  }
}
