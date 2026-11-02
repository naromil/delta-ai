import { useEffect, useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'
import type {
  CanvasCard,
  CanvasExpansionCard,
  CanvasPoint,
  CanvasSide
} from '../../../../shared/canvas'
import { canvasContinuations, clampPointInside, linkPath } from '../../../../shared/canvas'

interface CanvasLinksProps {
  cards: CanvasCard[]
  surfaceRef: RefObject<HTMLDivElement | null>
  /** Links of cards being dragged follow the pointer instead of easing after it. */
  dragging: boolean
  /** A click on a link, which travels to whichever end is farther from the click. */
  onFollow: (e: React.MouseEvent, id: string, start: CanvasPoint) => void
}

type TermOffsets = Readonly<Record<string, CanvasPoint>>

const SIDE_ANGLE: Readonly<Record<CanvasSide, number>> = {
  right: 0,
  bottom: 90,
  left: 180,
  top: 270
}

function isLinked(card: CanvasCard): card is CanvasExpansionCard {
  return card.kind === 'expansion' && !card.inset
}

/**
 * Each term's centre relative to its host card. Both come from the same DOM
 * reading of the scaled surface, so the result holds while a card lands, lifts
 * or the zoom is mid-transition.
 */
function measureTermOffsets(cards: CanvasCard[], surface: HTMLElement): TermOffsets {
  const offsets: Record<string, CanvasPoint> = {}
  for (const card of cards) {
    if (!isLinked(card)) continue
    const host = cards.find((other) => other.id === card.hostId)
    const hostEl = surface.querySelector(`[data-canvas-card="${card.hostId}"] .canvas-card-surface`)
    const term = hostEl?.querySelector(`[data-canvas-terms~="${card.expansionId}"]`)
    if (!host || !hostEl || !term) continue
    const hostBox = hostEl.getBoundingClientRect()
    const termBox = term.getBoundingClientRect()
    const scale = hostBox.width / host.rect.w
    offsets[card.id] = {
      x: (termBox.left + termBox.width / 2 - hostBox.left) / scale,
      y: (termBox.top + termBox.height / 2 - hostBox.top) / scale
    }
  }
  return offsets
}

function sameOffsets(a: TermOffsets, b: TermOffsets): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(
    (key) =>
      b[key] !== undefined &&
      Math.abs(a[key].x - b[key].x) < 0.5 &&
      Math.abs(a[key].y - b[key].y) < 0.5
  )
}

function LinkLine({ d }: { d: string }): React.JSX.Element {
  return (
    <path
      className="canvas-link-line"
      pathLength={1}
      style={{ d: `path("${d}")` } as React.CSSProperties}
    />
  )
}

const ARROW = 'M -8 -4.5 L 0 0 L -8 4.5 Z'
const CHEVRON = 'M -1.75 -3.5 L 1.75 0 L -1.75 3.5'

/** A mark that keeps its size on screen at any zoom, pointing the way a session travels. */
function pointerStyle(at: CanvasPoint, side: CanvasSide): React.CSSProperties {
  const place = `translate(${at.x}px, ${at.y}px) rotate(${SIDE_ANGLE[side]}deg)`
  return { transform: `${place} scale(calc(1 / var(--canvas-zoom)))` }
}

/**
 * What ties cards together: a link from each expanded term to its expansion once it stands
 * on its own, and for each continuation a mark on the boundary the two cards share, or a
 * link when they do not touch. A boundary with no mark is two cards merely placed together.
 */
function CanvasLinks({
  cards,
  surfaceRef,
  dragging,
  onFollow
}: CanvasLinksProps): React.JSX.Element {
  const [offsets, setOffsets] = useState<TermOffsets>({})

  const measure = (): void => {
    const surface = surfaceRef.current
    if (!surface) return
    const next = measureTermOffsets(cards, surface)
    setOffsets((prev) => (sameOffsets(prev, next) ? prev : next))
  }

  // Text reflows as answers stream, so every render may move a term.
  useLayoutEffect(measure)

  // The surface ref is attached after this child's first layout effect, so the
  // first real measurement happens here.
  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const handleScroll = (): void => {
      const next = measureTermOffsets(cards, surface)
      setOffsets((prev) => (sameOffsets(prev, next) ? prev : next))
    }
    handleScroll()
    surface.addEventListener('scroll', handleScroll, true)
    return () => surface.removeEventListener('scroll', handleScroll, true)
  }, [cards, surfaceRef])

  const links = cards.filter(isLinked).flatMap((card) => {
    const host = cards.find((other) => other.id === card.hostId)
    if (!host) return []
    const raw = offsets[card.id] ?? { x: host.rect.w / 2, y: host.rect.h / 2 }
    // A term scrolled out of its card hands its link to the card's edge.
    const from = clampPointInside({ x: host.rect.x + raw.x, y: host.rect.y + raw.y }, host.rect)
    return [{ id: card.id, from, d: linkPath(from, card.rect) }]
  })
  const continuations = canvasContinuations(cards)
  const sessionLinks = continuations.filter((item) => item.kind === 'link')
  const seams = continuations.filter((item) => item.kind === 'seam')
  const dragClass = dragging ? ' is-dragging' : ''

  // Drawn twice: strong under the cards for open space, and faint over them so a
  // link can be traced back to its term without striking through the text. Only the
  // part under the cards takes clicks, so a link never steals one meant for text.
  return (
    <>
      <svg className={`canvas-links canvas-links--under${dragClass}`} aria-hidden="true">
        {links.map(({ id, d, from }) => (
          <g key={id}>
            <LinkLine d={d} />
            <path className="canvas-link-hit" d={d} onClick={(e) => onFollow(e, id, from)}>
              <title>Follow this link</title>
            </path>
          </g>
        ))}
        {sessionLinks.map(({ id, d, start, end, side }) => (
          <g key={id} data-canvas-session-link={id}>
            <LinkLine d={d} />
            <path className="canvas-link-arrow" d={ARROW} style={pointerStyle(end, side)} />
            <path className="canvas-link-hit" d={d} onClick={(e) => onFollow(e, id, start)}>
              <title>Follow this link</title>
            </path>
          </g>
        ))}
      </svg>
      <svg className={`canvas-links canvas-links--over${dragClass}`} aria-hidden="true">
        {links.map(({ id, d, from }) => (
          <g key={id}>
            <LinkLine d={d} />
            <circle className="canvas-link-dot" cx={from.x} cy={from.y} r={3.5} />
          </g>
        ))}
        {sessionLinks.map(({ id, d, end, side }) => (
          <g key={id}>
            <LinkLine d={d} />
            <path className="canvas-link-arrow" d={ARROW} style={pointerStyle(end, side)} />
          </g>
        ))}
      </svg>
      <svg className={`canvas-links canvas-links--seams${dragClass}`} aria-hidden="true">
        {seams.map(({ id, start, end, side }) => (
          <g key={id} className="canvas-seam" data-canvas-seam={id}>
            <path
              className="canvas-seam-line"
              style={{ d: `path("M ${start.x} ${start.y} L ${end.x} ${end.y}")` }}
            />
            <g
              className="canvas-seam-mark"
              style={pointerStyle({ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, side)}
            >
              <circle r={8} />
              <path d={CHEVRON} />
            </g>
          </g>
        ))}
      </svg>
    </>
  )
}

export default CanvasLinks
