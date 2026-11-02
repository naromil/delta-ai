import type { ConversationMeta, ConversationRecord } from '../../shared/conversation'
import type { KbRunResult } from '../../shared/kb'
import { callProvider } from '../provider'
import { loadConversation, markConversationKbFed } from '../conversations'
import { memoryAgentFor } from '../memory/tools'
import { buildKbMemoryMessages, buildSingleMaterial } from './analysis'

export const CURATOR_UNAVAILABLE_ERROR =
  'The Knowledge Base Maintenance model cannot use tools, so it cannot update memories. Assign one that supports tool calling.'

export interface KbAnalysisOptions {
  /** Mark each processed conversation so it is not curated again. */
  markFed: boolean
  /** Aborts between conversations and mid-request, so a shutdown wins over a running pass. */
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
 * The model's reply is only a status line; what matters is what its tools wrote.
 * Without tools nothing can be saved, so this throws and the conversation stays unfed.
 */
async function updateMemories(material: string, signal?: AbortSignal): Promise<void> {
  const agent = memoryAgentFor('kb-maintenance')
  if (!agent) throw new Error(CURATOR_UNAVAILABLE_ERROR)
  await callProvider(buildKbMemoryMessages(material), 'kb-maintenance', signal, agent)
}

/**
 * Curates conversations into the document base one at a time, marking each fed
 * as it finishes so an interrupted run keeps its progress.
 *
 * Empty records carry no learning signal, so they are marked fed and skipped
 * rather than being retried forever.
 */
export async function runKbAnalysis(
  metas: Array<Pick<ConversationMeta, 'id'>>,
  options: KbAnalysisOptions
): Promise<KbRunResult> {
  let analyzed = 0

  for (const meta of metas) {
    if (options.signal?.aborted) break
    const record = await loadConversation(meta.id)
    if (!record) continue
    // The caller's list may predate the queue wait: a manual or automatic pass
    // that won the queue already curated this conversation.
    if (options.markFed && record.kbFed) continue

    if (!hasLearningMaterial(record)) {
      if (options.markFed) await markConversationKbFed(meta.id)
      continue
    }

    await updateMemories(buildSingleMaterial(record), options.signal)
    if (options.markFed) await markConversationKbFed(meta.id, record.updatedAt)
    analyzed++
  }

  return { conversationsAnalyzed: options.signal?.aborted ? 0 : analyzed }
}
