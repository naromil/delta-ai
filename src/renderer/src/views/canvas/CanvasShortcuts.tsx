interface ShortcutGroup {
  title: string
  items: ReadonlyArray<{ keys: string[]; what: string }>
}

const SHORTCUTS: readonly ShortcutGroup[] = [
  {
    title: 'Tools',
    items: [
      { keys: ['V'], what: 'Select: click, Shift+click, or drag a box around cards' },
      { keys: ['H'], what: 'Hand: drag anywhere to pan' },
      { keys: ['R'], what: 'Answer: draw a rectangle to ask in' },
      { keys: ['T'], what: 'Note: your own text' },
      { keys: ['C'], what: 'Connect: drag from one card to another' },
      { keys: ['F'], what: 'Frame: group a region under a title' }
    ]
  },
  {
    title: 'Asking',
    items: [
      { keys: ['Enter'], what: 'Reply below the focused card, or the newest one' },
      { keys: ['Shift', 'Enter'], what: 'Continue the focused card on its right' },
      { keys: ['A'], what: 'Ask about the selected cards' },
      { keys: ['N'], what: 'Ask a question in a new session' },
      { keys: ['E'], what: 'Edit the focused question and resend, or a note' },
      { keys: ['Double-click'], what: 'On empty space: ask here. On a title: zoom to it' }
    ]
  },
  {
    title: 'Selection',
    items: [
      { keys: ['Ctrl', 'A'], what: 'Select everything' },
      { keys: ['Shift', '↑↓←→'], what: 'Add the nearest card that way' },
      { keys: ['Ctrl', '↑↓←→'], what: 'Nudge the selection; Shift for further' },
      { keys: ['Ctrl', 'D'], what: 'Duplicate' },
      { keys: ['Ctrl', 'C'], what: 'Copy as markdown' },
      { keys: ['Ctrl', 'V'], what: 'Paste text as a note' },
      { keys: ['Ctrl', 'G'], what: 'Put in a frame' },
      { keys: ['.'], what: 'Collapse to the title, or expand' },
      { keys: ['Delete'], what: 'Delete' },
      { keys: ['Ctrl', 'Z'], what: 'Undo; add Shift to redo' },
      { keys: ['Alt', 'Drag'], what: 'Pull a card and its attached children away from the rest' }
    ]
  },
  {
    title: 'Getting around',
    items: [
      { keys: ['↑', '↓', '←', '→'], what: 'Go to the nearest card that way, or pan' },
      { keys: ['Tab'], what: 'Next card, term or button' },
      { keys: ['B'], what: 'Back: from an expansion to its term, or to the previous card' },
      { keys: ['Alt', '←', '→'], what: 'Back and forward through places you jumped to' },
      { keys: ['O'], what: 'Outline of every card' },
      { keys: ['Ctrl', 'F'], what: 'Search this canvas' },
      { keys: ['M'], what: 'Show or hide the map' },
      { keys: ['PgUp', 'PgDn'], what: 'Scroll the focused card' },
      { keys: ['Z'], what: 'Zoom to the selection' },
      { keys: ['+', '−', '0', '1'], what: 'Zoom in, zoom out, show everything, 100%' },
      { keys: ['Right-drag'], what: 'Pan, anywhere; a plain right click opens the menu' },
      { keys: ['Space'], what: 'Hold and drag to pan' },
      { keys: ['Ctrl', 'Scroll'], what: 'Zoom at the pointer' },
      { keys: ['Scroll'], what: 'Pan up and down' },
      { keys: ['Shift', 'Scroll'], what: 'Pan left and right' },
      { keys: ['Esc'], what: 'Cancel, then clear the selection' }
    ]
  }
]

/** The canvas keyboard and mouse map, toggled with `?`. */
function CanvasShortcuts({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <section className="canvas-shortcuts" aria-label="Keyboard and mouse shortcuts">
      <header className="canvas-shortcuts-header">
        <h2>Keyboard and mouse</h2>
        <button
          type="button"
          className="canvas-icon-btn canvas-icon-btn--close"
          aria-label="Close"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {SHORTCUTS.map(({ title, items }) => (
        <div key={title} className="canvas-shortcut-group">
          <h3>{title}</h3>
          <dl>
            {items.map(({ keys, what }) => (
              <div key={what} className="canvas-shortcut">
                <dt>
                  {keys.map((key) => (
                    <kbd key={key}>{key}</kbd>
                  ))}
                </dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      <p className="canvas-shortcuts-note">
        Clicking a link travels along it; the arrow button on an expansion returns to its term.
      </p>
    </section>
  )
}

export default CanvasShortcuts
