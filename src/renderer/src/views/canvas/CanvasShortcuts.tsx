const SHORTCUTS: ReadonlyArray<{ keys: string[]; what: string }> = [
  { keys: ['Enter'], what: 'Reply below the focused card, or the newest one' },
  { keys: ['Shift', 'Enter'], what: 'Continue the focused card on its right' },
  { keys: ['N'], what: 'Ask a question in a new session' },
  { keys: ['↑', '↓', '←', '→'], what: 'Go to the nearest card that way, or pan' },
  { keys: ['Tab'], what: 'Next card, term or button' },
  { keys: ['B'], what: 'Back: from an expansion to its term, or to the previous card' },
  { keys: ['PgUp', 'PgDn'], what: 'Scroll the focused card' },
  { keys: ['E'], what: 'Edit the focused question and resend' },
  { keys: ['Delete'], what: 'Delete the focused card' },
  { keys: ['R'], what: 'Select an area for a new answer' },
  { keys: ['V'], what: 'Move and read' },
  { keys: ['Space'], what: 'Hold and drag to pan' },
  { keys: ['+', '−', '0'], what: 'Zoom in, zoom out, show everything' },
  { keys: ['Esc'], what: 'Cancel' }
]

/** The canvas keyboard map, toggled with `?`. */
function CanvasShortcuts({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <section className="canvas-shortcuts" aria-label="Keyboard shortcuts">
      <header className="canvas-shortcuts-header">
        <h2>Keyboard</h2>
        <button
          type="button"
          className="canvas-icon-btn canvas-icon-btn--close"
          aria-label="Close"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <dl>
        {SHORTCUTS.map(({ keys, what }) => (
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
      <p className="canvas-shortcuts-note">
        Clicking a link travels along it; the arrow button on an expansion returns to its term.
      </p>
    </section>
  )
}

export default CanvasShortcuts
