import type { CanvasViewport } from '../../../shared/canvas'
import { chaseViewport } from '../../../shared/canvas'

/** Holds the layer and the React state back until a run of wheel events is over. */
const SETTLE_MS = 120

export interface ViewportMotionHost {
  read: () => CanvasViewport
  /** Puts a frame on screen and records it where `read` finds it; must not re-render. */
  paint: (viewport: CanvasViewport) => void
  /** Hands the resting viewport to React. */
  commit: (viewport: CanvasViewport) => void
  setMoving: (moving: boolean) => void
}

export interface ViewportMotion {
  /**
   * Changes where the view is heading. `immediate` also applies the change to what is
   * on screen, for input that already arrives in small steps (a trackpad, a drag).
   */
  steer: (change: (viewport: CanvasViewport) => CanvasViewport, immediate?: boolean) => void
  /** Stops where the view is now and commits it, before anything reads React's viewport. */
  settle: () => void
  /** Stops without committing, for a board that is going away. */
  cancel: () => void
}

/**
 * Wheel input moves the view many times a frame's worth of distance, far more often
 * than React should render the board, so frames are painted directly and React only
 * hears about the viewport once it rests.
 */
export function createViewportMotion(host: ViewportMotionHost): ViewportMotion {
  let target: CanvasViewport | null = null
  let frameId: number | null = null
  let settleTimer: number | null = null
  let lastFrame: number | null = null

  const clearPending = (): void => {
    if (frameId !== null) cancelAnimationFrame(frameId)
    if (settleTimer !== null) window.clearTimeout(settleTimer)
    frameId = null
    settleTimer = null
    lastFrame = null
  }

  const stop = (commit: boolean): void => {
    clearPending()
    if (target === null) return
    target = null
    host.setMoving(false)
    if (commit) host.commit(host.read())
  }

  const frame = (time: number): void => {
    if (target === null) return
    const elapsed = lastFrame === null ? 16 : time - lastFrame
    lastFrame = time
    const next = chaseViewport(host.read(), target, elapsed)
    host.paint(next)
    if (next === target) {
      frameId = null
      lastFrame = null
      settleTimer = window.setTimeout(() => stop(true), SETTLE_MS)
    } else {
      frameId = requestAnimationFrame(frame)
    }
  }

  return {
    steer: (change, immediate = false) => {
      if (target === null) host.setMoving(true)
      if (settleTimer !== null) window.clearTimeout(settleTimer)
      settleTimer = null
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      target = change(target ?? host.read())
      if (immediate || reduced) host.paint(reduced ? target : change(host.read()))
      if (frameId === null) frameId = requestAnimationFrame(frame)
    },
    settle: () => stop(true),
    cancel: () => stop(false)
  }
}
