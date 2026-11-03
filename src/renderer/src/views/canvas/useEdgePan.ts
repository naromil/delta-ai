import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

interface PointerPosition {
  clientX: number
  clientY: number
}

interface EdgePanOptions {
  active: boolean
  surfaceRef: RefObject<HTMLElement | null>
  /** Where the gesture began: a press that has not moved never pans. */
  pressRef: RefObject<PointerPosition | null>
  pointerRef: RefObject<PointerPosition | null>
  /** How far the view should move this frame, and where the pointer is. */
  onPan: (dx: number, dy: number, at: PointerPosition) => void
}

/** The band along the edge of the view that pans it while something is being dragged. */
const BAND_PX = 40
const SPEED_PX_PER_FRAME = 14
const MOVED_PX = 4

/** How fast one axis pans, given the pointer's distance from either end. */
function edgeSpeed(near: number, far: number): number {
  if (near < BAND_PX) return SPEED_PX_PER_FRAME * (1 - Math.max(near, 0) / BAND_PX)
  if (far < BAND_PX) return -SPEED_PX_PER_FRAME * (1 - Math.max(far, 0) / BAND_PX)
  return 0
}

/** Something dragged near the edge of the view pans the view towards it. */
export function useEdgePan({
  active,
  surfaceRef,
  pressRef,
  pointerRef,
  onPan
}: EdgePanOptions): void {
  const onPanRef = useRef(onPan)
  useEffect(() => {
    onPanRef.current = onPan
  }, [onPan])

  useEffect(() => {
    if (!active) return
    let moved = false
    const step = (): void => {
      frame = requestAnimationFrame(step)
      const box = surfaceRef.current?.getBoundingClientRect()
      const at = pointerRef.current
      const press = pressRef.current
      if (!box || !at || !press) return
      moved ||= Math.hypot(at.clientX - press.clientX, at.clientY - press.clientY) >= MOVED_PX
      if (!moved) return
      const dx = edgeSpeed(at.clientX - box.left, box.right - at.clientX)
      const dy = edgeSpeed(at.clientY - box.top, box.bottom - at.clientY)
      if (dx !== 0 || dy !== 0) onPanRef.current(dx, dy, at)
    }
    let frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [active, pointerRef, pressRef, surfaceRef])
}
