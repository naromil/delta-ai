import { KB_MEMORY_SYSTEM_PROMPT } from '../../shared/prompts'
import { normalizeCanvasLayout } from '../../shared/canvas'
import type { CanvasRecord, ConversationRecord, Turn } from '../../shared/conversation'
import type { ExpansionNode } from '../../shared/rich-text'
import type { ProviderMessage } from '../provider'

const ANSWER_LIMIT = 300

/** One question and its answer. `parentId` is the exchange whose history it continues. */
interface Exchange {
  id: string
  parentId?: string
  question?: Turn
  answer?: Turn
}

/** A run of exchanges with no fork inside it; a fork always starts new threads at its end. */
interface Thread {
  number: number
  continues?: number
  exchanges: Exchange[]
}

function clipAnswer(text: string): string {
  const answer = text.trim()
  return answer.length > ANSWER_LIMIT ? answer.slice(0, ANSWER_LIMIT) + '...' : answer
}

function collectExpansionContexts(
  source: string,
  nodes: ExpansionNode[],
  result: Array<{ term: string; prompt?: string; context: string; answer: string }>
): void {
  for (const node of nodes) {
    const before = source.slice(Math.max(0, node.start - 80), node.start)
    const after = source.slice(node.end, node.end + 80)
    result.push({
      term: node.originalText,
      prompt: node.prompt,
      context: (before + node.originalText + after).trim(),
      answer: clipAnswer(node.answer)
    })
    collectExpansionContexts(node.answer, node.children, result)
  }
}

/** Turns in order, as one line of conversation. */
function linearExchanges(turns: Turn[]): Exchange[] {
  const exchanges: Exchange[] = []
  for (const turn of turns) {
    const last = exchanges.at(-1)
    if (turn.role === 'assistant' && last && !last.answer) {
      last.answer = turn
      continue
    }
    exchanges.push({
      id: `turn:${turn.id}`,
      parentId: last?.id,
      ...(turn.role === 'user' ? { question: turn } : { answer: turn })
    })
  }
  return exchanges
}

/** A canvas keeps its turns in creation order, so only its cards say what follows what. */
function canvasExchanges(record: CanvasRecord): Exchange[] {
  const { turns } = record.state
  const { cards } = normalizeCanvasLayout(record.canvas, turns)
  const placed = new Set<number>()
  const exchanges: Exchange[] = []
  for (const card of cards) {
    if (card.kind !== 'message') continue
    placed.add(card.userTurnId).add(card.turnId)
    exchanges.push({
      id: card.id,
      parentId: card.parentId,
      question: turns.find((turn) => turn.id === card.userTurnId),
      answer: turns.find((turn) => turn.id === card.turnId)
    })
  }
  return [...exchanges, ...linearExchanges(turns.filter((turn) => !placed.has(turn.id)))]
}

/** A record that gains branches only needs to report its exchanges here. */
function conversationExchanges(record: ConversationRecord): Exchange[] {
  return record.source === 'canvas' ? canvasExchanges(record) : linearExchanges(record.state.turns)
}

function splitIntoThreads(exchanges: Exchange[]): Thread[] {
  const ids = new Set(exchanges.map((exchange) => exchange.id))
  const children = new Map<string, Exchange[]>()
  for (const exchange of exchanges) {
    if (exchange.parentId === undefined) continue
    children.set(exchange.parentId, [...(children.get(exchange.parentId) ?? []), exchange])
  }

  const threads: Thread[] = []
  const visited = new Set<string>()
  const walk = (start: Exchange, continues?: number): void => {
    if (visited.has(start.id)) return
    const thread: Thread = { number: threads.length + 1, continues, exchanges: [] }
    threads.push(thread)
    let current = start
    for (;;) {
      visited.add(current.id)
      thread.exchanges.push(current)
      const next = (children.get(current.id) ?? []).filter((child) => !visited.has(child.id))
      if (next.length !== 1) {
        for (const child of next) walk(child, thread.number)
        return
      }
      current = next[0]
    }
  }

  for (const exchange of exchanges) {
    if (exchange.parentId === undefined || !ids.has(exchange.parentId)) walk(exchange)
  }
  // Stored parent links are not trusted: anything only reachable through a cycle still counts.
  for (const exchange of exchanges) walk(exchange)
  return threads
}

function exchangeLines({ question, answer }: Exchange): string[] {
  const asked = question?.content.trim()
  // A failed turn stores error text for the UI; it is not something the assistant said.
  const answered = answer && !answer.error ? clipAnswer(answer.content) : ''
  const lines: string[] = []
  if (asked) lines.push('- User: ' + asked)
  if (answered) lines.push((asked ? '  ' : '- ') + 'Assistant: ' + answered)
  return lines
}

function threadHeader(thread: Thread): string {
  const continues = thread.continues === undefined ? '' : ` (continues Thread ${thread.continues})`
  return `Thread ${thread.number}${continues}:`
}

export function buildSingleMaterial(record: ConversationRecord): string {
  const parts: string[] = [
    `Title: ${record.title}`,
    `Date: ${record.updatedAt}`,
    `Source: ${record.source}`,
    '---'
  ]

  const threads = splitIntoThreads(conversationExchanges(record))
  const questionLines: string[] = []
  const expansionSummaries: Array<{
    term: string
    prompt?: string
    context: string
    answer: string
  }> = []

  for (const thread of threads) {
    if (threads.length > 1) questionLines.push(threadHeader(thread))
    for (const exchange of thread.exchanges) {
      questionLines.push(...exchangeLines(exchange))
      for (const turn of [exchange.question, exchange.answer]) {
        if (turn) collectExpansionContexts(turn.content, turn.expansions, expansionSummaries)
      }
    }
  }

  if (questionLines.length > 0) {
    parts.push('Questions:', ...questionLines, '')
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
        parts.push('  User asked: "' + es.prompt + '"')
      }
    }
    parts.push('')
  }

  return parts.join('\n')
}

export function buildKbMemoryMessages(materialsText: string): ProviderMessage[] {
  return [
    { role: 'system', content: KB_MEMORY_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Update the document base from this conversation:\n\n${materialsText}`
    }
  ]
}
