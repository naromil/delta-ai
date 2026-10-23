import { useEffect, useState } from 'react'

function renderCombo(e: React.KeyboardEvent<HTMLInputElement>): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')
  const key = e.key
  if (!['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
    parts.push(key.length === 1 ? key.toUpperCase() : key)
  }
  return parts.join('+')
}

interface HotkeyInputProps {
  value: string
  onChange: (value: string) => void
  /** `local` means the desktop refused the binding and only the in-app shortcut is armed. */
  mode?: 'global' | 'local'
}

function HotkeyInput({ value, onChange, mode = 'global' }: HotkeyInputProps): React.JSX.Element {
  const [capturing, setCapturing] = useState(false)

  /* The main process swallows the in-app shortcut before the page sees the key,
     so it has to stand down while this field is capturing a combination. */
  useEffect(() => {
    window.api.setHotkeyCaptureActive(capturing)
  }, [capturing])

  useEffect(() => {
    return () => window.api.setHotkeyCaptureActive(false)
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!capturing) return
    e.preventDefault()
    e.stopPropagation()
    const combo = renderCombo(e)
    if (combo) onChange(combo)
  }

  return (
    <div className="settings-section">
      <label className="settings-label" htmlFor="hotkey-input">
        Global Hotkey
      </label>
      <div className="hotkey-row">
        <input
          id="hotkey-input"
          type="text"
          className="settings-input settings-input--hotkey"
          value={value}
          readOnly
          onKeyDown={handleKeyDown}
          onFocus={() => setCapturing(true)}
          onBlur={() => setCapturing(false)}
          placeholder={capturing ? 'Press a key combination…' : 'Click to capture…'}
        />
      </div>
      <p className="settings-hint">
        Click the field, then press a key combination (e.g. Ctrl+Shift+D). Saved via the Save button
        below.
      </p>
      {mode === 'local' && (
        <p className="settings-hint settings-hint--notice">
          The desktop did not register this key for the whole system, so it is armed inside Delta AI
          only: press it while one of the app windows is focused. Expected when the app is started
          from a terminal (e.g. npm run dev) — a system-wide binding needs a desktop-launched
          process.
        </p>
      )}
    </div>
  )
}

export default HotkeyInput
