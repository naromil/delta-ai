import { useEffect, useState } from 'react'

const SHIFTED_SYMBOLS: Record<string, string> = {
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  _: '-',
  '+': '=',
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
  '~': '`'
}

const DISPLAY_KEYS: Record<string, string> = {
  ' ': 'Space',
  Escape: 'Esc',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  '+': 'Plus',
  '-': 'Minus',
  '=': 'Equal',
  '`': 'Backquote'
}

function renderCombo(e: React.KeyboardEvent<HTMLInputElement>): string {
  const key = e.key
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return ''

  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')

  // A bare letter would swallow that key system-wide; require a real modifier
  // (Shift alone is not enough) or a function key.
  const isFunctionKey = /^F\d{1,2}$/.test(key)
  if (!e.ctrlKey && !e.altKey && !e.metaKey && !isFunctionKey) return ''

  // `Shift+1` arrives as `!`; store the physical key instead of an invalid accelerator.
  const baseKey = e.shiftKey ? (SHIFTED_SYMBOLS[key] ?? key) : key
  parts.push(DISPLAY_KEYS[baseKey] ?? (baseKey.length === 1 ? baseKey.toUpperCase() : baseKey))
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
    if (e.key === 'Escape') {
      setCapturing(false)
      e.currentTarget.blur()
      return
    }
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
        {capturing
          ? 'Press a key combination (e.g. Ctrl+Shift+D), or Esc to cancel.'
          : 'Click the field to capture a key combination. A modifier (Ctrl, Alt or Meta) or an F-key is required; it saves automatically.'}
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
