import { loadConversation } from '../conversations'
import { KB_ANALYSIS_SYSTEM_PROMPT, KB_KEYWORD_SYSTEM_PROMPT } from '../../shared/prompts'
import type { ConversationRecord, ExpandableSegment } from '../../shared/conversation'
import type { CategorizedKeyword } from '../../shared/models'
import type { ProviderMessage } from '../provider'

function collectExpansionContexts(
  segments: ExpandableSegment[],
  result: Array<{ term: string; prompt?: string; context: string }>
): void {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (seg.kind === 'expansion') {
      const beforeSeg = i > 0 ? segments[i - 1] : null
      const afterSeg = i < segments.length - 1 ? segments[i + 1] : null
      const before = beforeSeg?.kind === 'text' ? beforeSeg.text : ''
      const after = afterSeg?.kind === 'text' ? afterSeg.text : ''

      const beforeText = before.length > 80 ? '...' + before.slice(-80) : before
      const afterText = after.length > 80 ? after.slice(0, 80) + '...' : after

      result.push({
        term: seg.originalText,
        prompt: seg.prompt,
        context: (beforeText + seg.originalText + afterText).trim()
      })

      collectExpansionContexts(seg.segments, result)
    }
  }
}

export function buildSingleMaterial(record: ConversationRecord): string {
  const parts: string[] = [
    `Title: ${record.title}`,
    `Date: ${record.updatedAt}`,
    `Source: ${record.source}`,
    '---'
  ]

  const questionSummaries: Array<{ question: string; previousResponse: string }> = []
  const expansionSummaries: Array<{ term: string; prompt?: string; context: string }> = []
  let lastAssistant = ''

  for (const turn of record.state.turns) {
    if (turn.role === 'assistant') {
      lastAssistant = turn.content
    }
    if (turn.role === 'user') {
      const text = turn.content.trim()
      if (text) {
        const prev =
          lastAssistant.length > 300 ? lastAssistant.slice(0, 300) + '...' : lastAssistant
        questionSummaries.push({ question: text, previousResponse: prev })
      }
    }
    if (turn.segments) {
      collectExpansionContexts(turn.segments, expansionSummaries)
    }
  }

  if (questionSummaries.length > 0) {
    parts.push('Questions:')
    for (const qs of questionSummaries) {
      if (qs.previousResponse) {
        parts.push('- Assistant: ' + qs.previousResponse)
      }
      parts.push('  User: ' + qs.question)
    }
    parts.push('')
  }

  if (expansionSummaries.length > 0) {
    parts.push('Expanded terms:')
    for (const es of expansionSummaries) {
      parts.push('- Context: ' + es.context)
      parts.push('  Term: "' + es.term + '"')
      if (es.prompt) {
        parts.push('  Prompt: "' + es.prompt + '"')
      }
    }
    parts.push('')
  }

  return parts.join('\n')
}

export async function buildKbMaterials(metas: Array<{ id: string }>): Promise<string> {
  const materials: string[] = []
  for (const meta of metas) {
    const record = await loadConversation(meta.id)
    if (!record) continue
    materials.push(buildSingleMaterial(record))
  }
  return materials.join('\n\n=====\n\n')
}

export function buildKbAnalysisMessages(
  currentPrompt: string,
  materialsText: string
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
            'Current personalization prompt:',
            '',
            currentPrompt,
            '',
            'Below are new conversation summaries. Rewrite/adjust the prompt above with new insights from these conversations:',
            '',
            materialsText
          ].join('\n')
        : [
            "Analyze these conversation summaries and generate a personalization prompt describing the user's learning preferences:",
            '',
            materialsText
          ].join('\n')
    }
  ]
}

export function buildKbKeywordMessages(
  learningPreference: string,
  existingKeywords: CategorizedKeyword[]
): ProviderMessage[] {
  const existingLines = existingKeywords.map(
    (kw) => `${kw.keyword} [${kw.category}] (count: ${kw.count})`
  )
  const existingBlock =
    existingLines.length > 0
      ? [
          '',
          'Existing keywords (reuse where still applicable; increment count by re-emiting):',
          ...existingLines
        ].join('\n')
      : ''

  return [
    {
      role: 'system',
      content: KB_KEYWORD_SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: [
        "Extract categorized keywords from this user's learning preference description:",
        '',
        learningPreference,
        existingBlock
      ].join('\n')
    }
  ]
}
