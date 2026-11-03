import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { CanvasFrame, CanvasLink, CanvasSide, CanvasViewport } from '../../../../shared/canvas'
import type { CanvasTool } from './CanvasToolRail'
import { isTyping, ownsKeys } from './board-helpers'

/** What the canvas does when a key is pressed. Listeners read the newest copy of this. */
export interface CanvasKeyboardActions {
  selectedRef: RefObject<ReadonlySet<string>>
  linksRef: RefObject<CanvasLink[]>
  framesRef: RefObject<CanvasFrame[]>
  viewportRef: RefObject<CanvasViewport>
  /* Esc works through these in order; null means there is nothing of that kind to cancel. */
  clearGesture: (() => void) | null
  closeHelp: (() => void) | null
  cancelPlacing: (() => void) | null
  cancelDraft: (() => void) | null
  clearSelection: () => void
  resetTool: (() => void) | null
  toggleHelp: () => void
  holdSpace: (held: boolean) => void
  chooseTool: (tool: CanvasTool) => void
  toggleOutline: () => void
  openOutline: () => void
  toggleMinimap: () => void
  zoomToSelection: () => void
  newSession: () => void
  askAboutSelection: () => void
  collapseSelection: () => void
  zoomBy: (factor: number) => void
  showEverything: () => void
  deleteSelection: () => void
  editLinkLabel: (id: string) => void
  editFrameTitle: (id: string) => void
  compose: () => void
  panBy: (dx: number, dy: number) => void
  undo: () => void
  redo: () => void
  selectEverything: () => void
  nudgeSelection: (side: CanvasSide, far: boolean) => void
  duplicateSelection: () => void
  frameSelection: () => void
  copySelection: () => void
  travelViewHistory: (direction: 'back' | 'forward') => void
  pasteText: (text: string) => void
}

export const ZOOM_STEP = 1.25
/** How far an arrow key pans, in screen pixels; Shift pans further. */
const PAN_STEP = 80
const PAN_STEP_LARGE = 320

const ARROW_SIDES: Readonly<Record<string, CanvasSide>> = {
  ArrowRight: 'right',
  ArrowLeft: 'left',
  ArrowDown: 'bottom',
  ArrowUp: 'top'
}

const TOOL_KEYS: Readonly<Record<string, CanvasTool>> = {
  v: 'select',
  h: 'hand',
  r: 'answer',
  t: 'note',
  c: 'connect',
  f: 'frame'
}

/** Ctrl/Cmd keys. Returns whether the key was the canvas's to take. */
function handleModifierKey(e: KeyboardEvent, actions: CanvasKeyboardActions): boolean {
  const key = e.key.toLowerCase()
  if (key === 'f') {
    actions.openOutline()
    return true
  }
  if (isTyping(e.target)) return false
  const side = ARROW_SIDES[e.key]
  if (key === 'z') {
    if (e.shiftKey) actions.redo()
    else actions.undo()
    return true
  }
  if (key === 'y') {
    actions.redo()
    return true
  }
  if (key === 'a') {
    actions.selectEverything()
    return true
  }
  if (side) {
    actions.nudgeSelection(side, e.shiftKey)
    return true
  }
  if (actions.selectedRef.current.size === 0) return false
  if (key === 'd') actions.duplicateSelection()
  else if (key === 'g') actions.frameSelection()
  else if (key === 'c') {
    // Text selected inside an answer copies as text, as anywhere else.
    if (!(window.getSelection()?.isCollapsed ?? true)) return false
    actions.copySelection()
  } else return false
  return true
}

function handleEscape(actions: CanvasKeyboardActions): void {
  const cancel =
    actions.clearGesture ??
    actions.closeHelp ??
    actions.cancelPlacing ??
    actions.cancelDraft ??
    (actions.selectedRef.current.size > 0 ? actions.clearSelection : actions.resetTool)
  cancel?.()
}

/** Enter with nothing focused: a selected line or frame is edited, otherwise it is the composer. */
function handleEnter(actions: CanvasKeyboardActions): void {
  const selected = actions.selectedRef.current
  const only = selected.size === 1 ? [...selected][0] : undefined
  if (only !== undefined && actions.linksRef.current.some((link) => link.id === only)) {
    actions.editLinkLabel(only)
  } else if (only !== undefined && actions.framesRef.current.some((frame) => frame.id === only)) {
    actions.editFrameTitle(only)
  } else {
    actions.compose()
  }
}

function handlePlainKey(e: KeyboardEvent, actions: CanvasKeyboardActions): void {
  const key = e.key.toLowerCase()
  const hasSelection = actions.selectedRef.current.size > 0
  const tool = TOOL_KEYS[key]
  const side = ARROW_SIDES[e.key]
  if (e.key === ' ') {
    // Space still presses whatever button has focus.
    if ((e.target as Element).closest?.('button, [role="button"]')) return
    e.preventDefault()
    actions.holdSpace(true)
  } else if (e.key === '?') {
    e.preventDefault()
    actions.toggleHelp()
  } else if (tool) {
    e.preventDefault()
    actions.chooseTool(tool)
  } else if (key === 'o') {
    // The outline focuses its search box before this key would finish typing.
    e.preventDefault()
    actions.toggleOutline()
  } else if (key === 'm') {
    actions.toggleMinimap()
  } else if (key === 'z') {
    actions.zoomToSelection()
  } else if (key === 'n') {
    e.preventDefault()
    actions.newSession()
  } else if (key === 'a' && hasSelection) {
    e.preventDefault()
    actions.askAboutSelection()
  } else if (e.key === '.' && hasSelection) {
    actions.collapseSelection()
  } else if (e.key === '+' || e.key === '=') {
    actions.zoomBy(ZOOM_STEP)
  } else if (e.key === '-') {
    actions.zoomBy(1 / ZOOM_STEP)
  } else if (e.key === '0') {
    actions.showEverything()
  } else if (e.key === '1') {
    actions.zoomBy(1 / actions.viewportRef.current.zoom)
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && hasSelection) {
    e.preventDefault()
    actions.deleteSelection()
  } else if (ownsKeys(e.target)) {
    return
  } else if (e.key === 'Enter') {
    e.preventDefault()
    handleEnter(actions)
  } else if (side) {
    e.preventDefault()
    const step = e.shiftKey ? PAN_STEP_LARGE : PAN_STEP
    const dx = side === 'left' ? step : side === 'right' ? -step : 0
    const dy = side === 'top' ? step : side === 'bottom' ? -step : 0
    actions.panBy(dx, dy)
  }
}

export function handleKeyDown(e: KeyboardEvent, actions: CanvasKeyboardActions): void {
  if (e.defaultPrevented) return
  if (e.ctrlKey || e.metaKey) {
    if (!e.altKey && handleModifierKey(e, actions)) e.preventDefault()
    return
  }
  if (e.altKey) {
    if (!isTyping(e.target) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      actions.travelViewHistory(e.key === 'ArrowLeft' ? 'back' : 'forward')
    }
    return
  }
  if (e.key === 'Escape') {
    handleEscape(actions)
    return
  }
  if (!isTyping(e.target)) handlePlainKey(e, actions)
}

/** Keys that work anywhere on the board; a focused card's own keys are in `handleCardKeyDown`. */
export function useCanvasKeyboard(actions: CanvasKeyboardActions): void {
  const actionsRef = useRef(actions)
  useEffect(() => {
    actionsRef.current = actions
  })

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => handleKeyDown(e, actionsRef.current)
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === ' ') actionsRef.current.holdSpace(false)
    }
    const onPaste = (e: ClipboardEvent): void => {
      if (isTyping(e.target)) return
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (text.trim() === '') return
      e.preventDefault()
      actionsRef.current.pasteText(text)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('paste', onPaste)
    }
  }, [])
}
