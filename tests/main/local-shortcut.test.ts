import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  configureLocalShortcut,
  installLocalShortcut,
  setHotkeyCaptureActive
} from '../../src/main/services/local-shortcut'

/* ---- Harness: capture the `before-input-event` listener of a fake window ---- */

type Listener = (event: { preventDefault: () => void }, input: unknown) => void

let listeners: Listener[] = []
let handler: Mock<() => void>

const fakeWindow = {
  webContents: {
    on: (_event: string, listener: Listener): void => {
      listeners.push(listener)
    }
  }
}

function install(): void {
  listeners = []
  installLocalShortcut(fakeWindow as never, handler)
}

function press(overrides: Record<string, unknown> = {}): boolean {
  let prevented = false
  const input = {
    type: 'keyDown',
    key: 'D',
    code: 'KeyD',
    isAutoRepeat: false,
    control: true,
    shift: true,
    alt: false,
    meta: false,
    ...overrides
  }
  for (const listener of listeners) {
    listener({ preventDefault: () => (prevented = true) }, input)
  }
  return prevented
}

beforeEach(() => {
  handler = vi.fn<() => void>()
  setHotkeyCaptureActive(false)
  configureLocalShortcut('Ctrl+Shift+D', true)
  install()
})

afterEach(() => {
  configureLocalShortcut('Ctrl+Shift+D', false)
})

describe('local shortcut fallback', () => {
  it('fires for the configured combination', () => {
    expect(press()).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('ignores the order the modifiers were configured in', () => {
    configureLocalShortcut('Shift+Ctrl+D', true)
    expect(press()).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('does not fire on a superset of the modifiers', () => {
    expect(press({ alt: true })).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('does not fire on a subset of the modifiers', () => {
    expect(press({ shift: false, key: 'd' })).toBe(false)
    expect(press({ control: false, shift: false, key: 'd' })).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('does not fire for another key', () => {
    expect(press({ key: 'K', code: 'KeyK' })).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('maps accelerator key names onto KeyboardEvent.key', () => {
    configureLocalShortcut('Ctrl+Shift+Space', true)
    expect(press({ key: ' ', code: 'Space' })).toBe(true)

    configureLocalShortcut('Ctrl+Shift+Esc', true)
    expect(press({ key: 'Escape', code: 'Escape' })).toBe(true)

    configureLocalShortcut('Alt+Plus', true)
    expect(press({ alt: true, control: false, shift: false, key: '+' })).toBe(true)

    configureLocalShortcut('Ctrl+Shift+Up', true)
    expect(press({ key: 'ArrowUp', code: 'ArrowUp' })).toBe(true)

    expect(handler).toHaveBeenCalledTimes(4)
  })

  it('matches shifted number-row and punctuation keys', () => {
    configureLocalShortcut('Ctrl+Shift+1', true)
    expect(press({ key: '!', code: 'Digit1' })).toBe(true)

    configureLocalShortcut('Ctrl+Shift+Equal', true)
    expect(press({ key: '+', code: 'Equal' })).toBe(true)

    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('ignores key-up and auto-repeat', () => {
    expect(press({ type: 'keyUp' })).toBe(false)
    expect(press({ isAutoRepeat: true })).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('stays inert until a fallback is armed', () => {
    configureLocalShortcut('Ctrl+Shift+D', false)
    expect(press()).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('stands down while the settings field captures a combination', () => {
    setHotkeyCaptureActive(true)
    expect(press()).toBe(false)
    expect(handler).not.toHaveBeenCalled()

    setHotkeyCaptureActive(false)
    expect(press()).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('ignores an unparsable accelerator', () => {
    configureLocalShortcut('', true)
    expect(press()).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('survives a rejected handler', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('boom'))
    listeners = []
    installLocalShortcut(fakeWindow as never, failing)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    press()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(failing).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
