import { loadConversation } from '../conversations'
import { KB_ANALYSIS_SYSTEM_PROMPT } from '../../shared/prompts'
import type { ProviderMessage } from '../provider'

export async function buildKbTranscripts(metas: Array<{ id: string }>): Promise<string[]> {
  const transcripts: string[] = []
  for (const meta of metas) {
    const record = await loadConversation(meta.id)
    if (!record) continue
    const lines: string[] = [
      `Title: ${record.title}`,
      `Date: ${record.updatedAt}`,
      `Source: ${record.source}`,
      '---'
    ]
    for (const turn of record.state.turns) {
      lines.push(`${turn.role}: ${turn.content}`)
      lines.push('')
    }
    transcripts.push(lines.join('\n'))
  }
  return transcripts
}

export function buildKbAnalysisMessages(
  currentPrompt: string,
  transcripts: string[]
): ProviderMessage[] {
  return [
    {
      role: 'system',
      content: KB_ANALYSIS_SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: currentPrompt
        ? [
            'Current personalized prompt:',
            '',
            currentPrompt,
            '',
            'Below are new conversation transcripts. Update/augment the prompt above with new insights from these conversations:',
            '',
            transcripts.join('\n\n=====\n\n')
          ].join('\n')
        : [
            "Analyze these conversation transcripts and generate a personalized prompt describing the user's learning preferences:",
            '',
            transcripts.join('\n\n=====\n\n')
          ].join('\n')
    }
  ]
}
