import { KB_ANALYSIS_SYSTEM_PROMPT, KB_KEYWORD_SYSTEM_PROMPT } from '../../shared/prompts'
import type { ConversationRecord } from '../../shared/conversation'
import type { ExpansionNode } from '../../shared/rich-text'
import type { CategorizedKeyword } from '../../shared/models'
import type { ProviderMessage } from '../provider'

function collectExpansionContexts(
  source: string,
  nodes: ExpansionNode[],
  result: Array<{ term: string; prompt?: string; context: string; answer: string }>
): void {
  for (const node of nodes) {
    const before = source.slice(Math.max(0, node.start - 80), node.start)
    const after = source.slice(node.end, node.end + 80)
    const answer = node.answer.trim()
    result.push({
      term: node.originalText,
      prompt: node.prompt,
      context: (before + node.originalText + after).trim(),
      answer: answer.length > 300 ? answer.slice(0, 300) + '...' : answer
    })
    collectExpansionContexts(node.answer, node.children, result)
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
  const expansionSummaries: Array<{
    term: string
    prompt?: string
    context: string
    answer: string
  }> = []
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
    collectExpansionContexts(turn.content, turn.expansions, expansionSummaries)
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
      if (es.answer) {
        parts.push('  Answer: ' + es.answer)
      }
      if (es.prompt) {
        parts.push('  Prompt: "' + es.prompt + '"')
      }
    }
    parts.push('')
  }

  return parts.join('\n')
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
