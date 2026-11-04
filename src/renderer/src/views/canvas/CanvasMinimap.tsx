import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import type {
  CanvasCard,
  CanvasFrame,
  CanvasPoint,
  CanvasRect,
  CanvasViewport
} from '../../../../shared/canvas'
import { unionRect, visibleWorldRect } from '../../../../shared/canvas'
import { boundsOf } from '../../../../shared/canvas-selection'

export interface CanvasMinimapHandle {
  /** Follows the viewport frame by frame, without rendering anything. */
  paint: (viewport: CanvasViewport) => void
}

interface CanvasMinimapProps {
  cards: CanvasCard[]
  frames: CanvasFrame[]
  selectedIds: ReadonlySet<string>
  size: { width: number; height: number }
  viewportRef: React.RefObject<CanvasViewport>
  /** The world point to centre the view on; `dragging` means it arrives in small steps. */
  onNavigate: (point: CanvasPoint, dragging: boolean) => void
}

const PADDING_FRACTION = 0.08

/** The whole canvas at a glance: click or drag to go somewhere. */
const CanvasMinimap = forwardRef<CanvasMinimapHandle, CanvasMinimapProps>(function CanvasMinimap(
  { cards, frames, selectedIds, size, viewportRef, onNavigate },
  ref
) {
  const svgRef = useRef<SVGSVGElement>(null)
  const viewRef = useRef<SVGRectElement>(null)
  const heldRef = useRef(false)
  const content = boundsOf([...cards.map((card) => card.rect), ...frames.map((f) => f.rect)])

  const paint = useCallback(
    (viewport: CanvasViewport): void => {
      const visible = visibleWorldRect(viewport, size)
      const view = viewRef.current
      if (view) {
        view.setAttribute('x', String(visible.x))
        view.setAttribute('y', String(visible.y))
        view.setAttribute('width', String(visible.w))
        view.setAttribute('height', String(visible.h))
      }
      // Held still under a drag, or the map would slide away from the pointer.
      if (heldRef.current) return
      const whole: CanvasRect = content ? unionRect(content, visible) : visible
      const pad = Math.max(whole.w, whole.h) * PADDING_FRACTION
      svgRef.current?.setAttribute(
        'viewBox',
        `${whole.x - pad} ${whole.y - pad} ${whole.w + pad * 2} ${whole.h + pad * 2}`
      )
    },
    [content, size]
  )

  useImperativeHandle(ref, () => ({ paint }), [paint])

  useLayoutEffect(() => {
    paint(viewportRef.current)
  })

  const worldPoint = (e: React.PointerEvent): CanvasPoint | null => {
    const matrix = svgRef.current?.getScreenCTM()
    if (!matrix) return null
    const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse())
    return { x: point.x, y: point.y }
  }

  return (
    <svg
      ref={svgRef}
      className="canvas-minimap"
      role="img"
      aria-label="Map of the canvas. Click to go somewhere."
      preserveAspectRatio="xMidYMid meet"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        heldRef.current = true
        const point = worldPoint(e)
        if (point) onNavigate(point, false)
      }}
      onPointerMove={(e) => {
        if (!heldRef.current) return
        const point = worldPoint(e)
        if (point) onNavigate(point, true)
      }}
      onPointerUp={() => {
        heldRef.current = false
        paint(viewportRef.current)
      }}
      onPointerCancel={() => {
        heldRef.current = false
      }}
    >
      {frames.map((frame) => (
        <rect
          key={frame.id}
          className={`canvas-minimap-frame${selectedIds.has(frame.id) ? ' is-selected' : ''}`}
          data-color={frame.color}
          x={frame.rect.x}
          y={frame.rect.y}
          width={frame.rect.w}
          height={frame.rect.h}
        />
      ))}
      {cards.map((card) => (
        <rect
          key={card.id}
          className={`canvas-minimap-card${selectedIds.has(card.id) ? ' is-selected' : ''}`}
          data-color={card.color}
          x={card.rect.x}
          y={card.rect.y}
          width={card.rect.w}
          height={card.rect.h}
        />
      ))}
      <rect ref={viewRef} className="canvas-minimap-view" />
    </svg>
  )
})

export default CanvasMinimap
