import type { CanvasCard } from '../../../../shared/canvas'
import type { ExpansionNode } from '../../../../shared/rich-text'
import { findExpansionInTurns, flattenMarkdown } from '../../../../shared/rich-text'
import type { useCanvas } from '../../hooks/useCanvas'
import type { CanvasCardStatus } from './CanvasCardView'

type CanvasContentSource = Pick<ReturnType<typeof useCanvas>, 'turns' | 'streamingTurnIds'>

export interface CanvasCardContent {
  caption: string
  question?: string
  answer: string
  expansions: ExpansionNode[]
  status: CanvasCardStatus
  failure?: string
}

/** Reads the status and text a card should show from its turn or expansion. */
export function cardContent(card: CanvasCard, canvas: CanvasContentSource): CanvasCardContent {
  if (card.kind === 'note')
    return { caption: '', answer: card.text, expansions: [], status: 'done' }
  if (card.kind === 'message') {
    const user = canvas.turns.find((turn) => turn.id === card.userTurnId)
    const turn = canvas.turns.find((item) => item.id === card.turnId)
    const content = turn?.content ?? ''
    const streaming = canvas.streamingTurnIds.has(card.turnId)
    const blank = content.trim() === ''
    const failed = !streaming && (turn?.error === true || blank)
    return {
      caption: user?.content ?? '',
      answer: content,
      expansions: turn?.expansions ?? [],
      status: streaming ? 'streaming' : failed ? 'failed' : 'done',
      ...(failed ? { failure: blank ? 'Stopped before an answer.' : content } : {})
    }
  }
  const node = findExpansionInTurns(canvas.turns, card.expansionId)?.node
  return {
    caption: flattenMarkdown(node?.originalText ?? ''),
    ...(node?.prompt?.trim() ? { question: node.prompt.trim() } : {}),
    answer: node?.answer ?? '',
    expansions: node?.children ?? [],
    status: node?.status === 'loading' ? 'streaming' : node?.status === 'error' ? 'failed' : 'done',
    ...(node?.status === 'error' ? { failure: node.error ?? 'The answer failed.' } : {})
  }
}
