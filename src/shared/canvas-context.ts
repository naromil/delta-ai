/**
 * Context links: material from elsewhere on the plane, sent with a branch's requests.
 *
 * A link is read when a request is built, never stored in a turn, so editing a note or
 * deleting a link changes what the next request sends. It reaches every card after its end
 * on that branch, and stops at one hop: what fed the linked branch is not sent again.
 */
import type { CanvasCard, CanvasLink, CanvasLinkContext } from './canvas'
import { sessionCardIds, turnsThroughCard } from './canvas'
import { SOURCE_TEXT_LIMIT, cardText } from './canvas-selection'
import type { Turn } from './conversation'
import type { CanvasContextExcerpt } from './prompts'
import { flattenMarkdown } from './rich-text'

/** Keeps the newest part: the end of a branch is what the link points at. */
const BRANCH_TEXT_LIMIT = 12000
/** The newest message is never trimmed by the context budget, so this bounds what it gains. */
const TOTAL_TEXT_LIMIT = 24000

export type CanvasContextLink = Pick<CanvasLink, 'from'> & {
  context: CanvasLinkContext
  label?: string
}

export interface CanvasContextResult {
  items: CanvasContextExcerpt[]
  /** Something was cut or left out to stay within the limits. */
  clipped: boolean
}

/** The links feeding a card's branch, nearest first; a source linked twice counts once, whole. */
export function sessionContextLinks(
  cards: CanvasCard[],
  links: CanvasLink[],
  id: string | undefined
): CanvasContextLink[] {
  const bySource = new Map<string, CanvasContextLink>()
  for (const cardId of sessionCardIds(cards, id)) {
    for (const link of links) {
      if (link.to !== cardId || !link.context) continue
      const known = bySource.get(link.from)
      if (known?.context === 'branch' || (known && link.context === 'card')) continue
      bySource.set(link.from, {
        from: link.from,
        context: link.context,
        ...(link.label ? { label: link.label } : {})
      })
    }
  }
  return [...bySource.values()]
}

function branchTranscript(turns: Turn[]): string {
  return turns
    .filter((turn) => turn.content.trim() !== '' && !turn.error)
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content.trim()}`)
    .join('\n\n')
}

function failedAnswer(card: CanvasCard, turns: Turn[]): boolean {
  return card.kind === 'message' && turns.some((turn) => turn.id === card.turnId && turn.error)
}

function ownTurnId(card: CanvasCard): number | undefined {
  return card.kind === 'message' ? card.turnId : undefined
}

/**
 * The text each link sends. `history` is what the request carries anyway, so it and
 * anything an earlier link already sent appear once. `skip` names cards sent another way.
 */
export function contextExcerpts(
  cards: CanvasCard[],
  turns: Turn[],
  links: readonly CanvasContextLink[],
  history: readonly Turn[],
  skip: readonly string[] = []
): CanvasContextResult {
  const seen = new Set(history.map((turn) => turn.id))
  const items: CanvasContextExcerpt[] = []
  let room = TOTAL_TEXT_LIMIT
  let clipped = false
  for (const link of links) {
    const card = cards.find((item) => item.id === link.from)
    if (!card || skip.includes(card.id)) continue
    const { title, body } = cardText(card, turns)
    const asBranch = card.kind !== 'note' && link.context === 'branch'
    const own = ownTurnId(card)
    let text: string
    let limit: number
    if (asBranch) {
      const fresh = turnsThroughCard(cards, turns, card.id).filter((turn) => !seen.has(turn.id))
      text = branchTranscript(fresh)
      limit = BRANCH_TEXT_LIMIT
      for (const turn of fresh) seen.add(turn.id)
    } else {
      if ((own !== undefined && seen.has(own)) || failedAnswer(card, turns)) continue
      text = body
      limit = SOURCE_TEXT_LIMIT
      if (own !== undefined) seen.add(own)
    }
    if (text.trim() === '') continue
    if (room <= 0) {
      clipped = true
      continue
    }
    const allowed = Math.min(limit, room)
    if (text.length > allowed) {
      clipped = true
      text = asBranch ? `…${text.slice(-allowed)}` : `${text.slice(0, allowed)}…`
    }
    room -= text.length
    items.push({
      kind: card.kind === 'note' ? 'note' : asBranch ? 'branch' : 'card',
      title: flattenMarkdown(title),
      text,
      ...(link.label ? { label: link.label } : {})
    })
  }
  return { items, clipped }
}

/** What a request from this card sends through links, for whichever branch it stands on. */
export function requestContext(
  cards: CanvasCard[],
  links: CanvasLink[],
  turns: Turn[],
  id: string,
  skip: readonly string[] = []
): CanvasContextExcerpt[] {
  const history = turnsThroughCard(cards, turns, id)
  return contextExcerpts(cards, turns, sessionContextLinks(cards, links, id), history, skip).items
}
