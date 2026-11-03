import type { CanvasCard } from '../../../../shared/canvas'
import type { ContextMenuItem } from '../../components/conversation/ContextMenu'

/** Right-click menus, one list per thing on the plane. Each names the key that does the same. */

export function planeMenuItems(actions: {
  askHere: () => void
  noteHere: () => void
  selectEverything: () => void
  tidyUp: () => void
  showEverything: () => void
}): ContextMenuItem[] {
  return [
    { label: 'Ask here', shortcut: 'Double-click', onSelect: actions.askHere },
    { label: 'Note here', shortcut: 'T', onSelect: actions.noteHere },
    { label: 'Select everything', shortcut: 'Ctrl+A', onSelect: actions.selectEverything },
    { label: 'Tidy up the canvas', onSelect: actions.tidyUp },
    { label: 'Show everything', shortcut: '0', onSelect: actions.showEverything }
  ]
}

export function cardMenuItems(
  card: CanvasCard,
  actions: {
    ask: () => void
    duplicate: () => void
    copy: () => void
    collapse: () => void
    frame: () => void
    zoom: () => void
    remove: () => void
  }
): ContextMenuItem[] {
  return [
    { label: 'Ask about this', shortcut: 'A', onSelect: actions.ask },
    { label: 'Duplicate', shortcut: 'Ctrl+D', onSelect: actions.duplicate },
    { label: 'Copy as markdown', shortcut: 'Ctrl+C', onSelect: actions.copy },
    ...(card.kind === 'note'
      ? []
      : [
          {
            label: card.collapsedFrom === undefined ? 'Collapse to title' : 'Expand',
            shortcut: '.',
            onSelect: actions.collapse
          }
        ]),
    { label: 'Put in a frame', shortcut: 'Ctrl+G', onSelect: actions.frame },
    { label: 'Zoom to this', shortcut: 'Z', onSelect: actions.zoom },
    { label: 'Delete', shortcut: 'Del', onSelect: actions.remove }
  ]
}

export function frameMenuItems(actions: {
  rename: () => void
  zoom: () => void
  selectInside: () => void
  duplicate: () => void
  remove: () => void
}): ContextMenuItem[] {
  return [
    { label: 'Rename', shortcut: 'F2', onSelect: actions.rename },
    { label: 'Zoom to this', shortcut: 'Z', onSelect: actions.zoom },
    { label: 'Select what is inside', onSelect: actions.selectInside },
    { label: 'Duplicate', shortcut: 'Ctrl+D', onSelect: actions.duplicate },
    { label: 'Remove frame, keep cards', onSelect: actions.remove }
  ]
}

export function linkMenuItems(actions: {
  label: () => void
  reverse: () => void
  goToStart: () => void
  goToEnd: () => void
  remove: () => void
}): ContextMenuItem[] {
  return [
    { label: 'Label', shortcut: 'Enter', onSelect: actions.label },
    { label: 'Reverse direction', onSelect: actions.reverse },
    { label: 'Go to the start', onSelect: actions.goToStart },
    { label: 'Go to the end', onSelect: actions.goToEnd },
    { label: 'Delete', shortcut: 'Del', onSelect: actions.remove }
  ]
}
