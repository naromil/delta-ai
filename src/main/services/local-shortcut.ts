/**
 * In-app fallback for the global hotkey.
 *
 * `globalShortcut` and the XDG GlobalShortcuts portal can both refuse to bind a
 * key. The common case is a development run started from a terminal: KDE only
 * hands the portal an app id for apps launched by systemd, so `BindShortcuts`
 * fails with `NotAllowed` and the lookup becomes unreachable. To keep the
 * feature usable, the same accelerator is also matched against the keyboard
 * events of our own windows, where it fires as long as one of them has focus.
 *
 * The fallback is armed by `registerHotkey` only when the desktop refused the
 * binding, so a working global shortcut never fires twice.
 */
import type { BrowserWindow } from 'electron'

/* ---- Accelerator parsing ---- */

interface ParsedAccelerator {
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  key: string
}

/** Electron accelerator key names → `KeyboardEvent.key` (lowercased). */
const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  space: ' ',
  spacebar: ' ',
  plus: '+',
  minus: '-',
  equal: '=',
  backquote: '`',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  numadd: '+',
  numsub: '-',
  nummult: '*',
  numdiv: '/',
  numdec: '.'
}

function normalizeKey(raw: string): string {
  const lower = raw.toLowerCase()
  return KEY_ALIASES[lower] ?? lower
}

/**
 * Splits an Electron accelerator (`Ctrl+Shift+D`) into modifiers plus one key,
 * normalized the way `before-input-event` reports it.
 */
function parseAccelerator(accelerator: string): ParsedAccelerator | null {
  const parsed: ParsedAccelerator = { ctrl: false, alt: false, shift: false, meta: false, key: '' }

  for (const rawPart of accelerator.split('+')) {
    const part = rawPart.trim().toLowerCase()
    if (part === '') {
      // `Ctrl++` (the `+` key) leaves empty segments behind.
      if (!parsed.key) parsed.key = '+'
      continue
    }
    switch (part) {
      case 'ctrl':
      case 'control':
        parsed.ctrl = true
        break
      case 'commandorcontrol':
      case 'cmdorctrl':
        if (process.platform === 'darwin') parsed.meta = true
        else parsed.ctrl = true
        break
      case 'alt':
      case 'option':
        parsed.alt = true
        break
      case 'shift':
        parsed.shift = true
        break
      case 'cmd':
      case 'command':
      case 'super':
      case 'meta':
        parsed.meta = true
        break
      default:
        parsed.key = normalizeKey(part)
    }
  }

  return parsed.key ? parsed : null
}

/** `KeyboardEvent.key` while Shift is down → the unshifted key from the accelerator. */
const SHIFTED_KEYS: Record<string, string> = {
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

/** Exact modifier match — a superset press (`Ctrl+Alt+Shift+D`) must not fire. */
function matchesInput(accel: ParsedAccelerator, input: Electron.Input): boolean {
  const key = normalizeKey(input.key)
  return (
    input.control === accel.ctrl &&
    input.alt === accel.alt &&
    input.shift === accel.shift &&
    input.meta === accel.meta &&
    (key === accel.key || (input.shift && SHIFTED_KEYS[key] === accel.key))
  )
}

/* ---- State ---- */

let accel: ParsedAccelerator | null = null
let captureActive = false

/** Arm (or disarm) the fallback for `accelerator`. Driven by `registerHotkey`. */
export function configureLocalShortcut(accelerator: string, enabled: boolean): void {
  accel = enabled ? parseAccelerator(accelerator) : null
}

export function isLocalShortcutActive(): boolean {
  return accel !== null
}

/** Suspend the fallback while the Settings field captures a key combination. */
export function setHotkeyCaptureActive(active: boolean): void {
  captureActive = active
}

/* ---- Window wiring ---- */

/**
 * Mirror the global shortcut inside one of our windows, which is the only place
 * a terminal-launched run can hear it.
 */
export function installLocalShortcut(
  window: BrowserWindow,
  onPressed: () => void | Promise<void>
): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (!accel || captureActive) return
    if (input.type !== 'keyDown' || input.isAutoRepeat) return
    if (!matchesInput(accel, input)) return
    event.preventDefault()
    void Promise.resolve(onPressed()).catch((err) => {
      console.warn('Local shortcut handler failed:', err)
    })
  })
}
