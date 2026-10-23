import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A backend that never answers is the failure mode seen on xdg-desktop-portal-kde
 * when the requested trigger is already taken: no `Response` signal ever arrives,
 * so an unbounded await would block `app.whenReady` and the app would start with
 * no window at all — and the in-app fallback could never arm.
 */
vi.mock('dbus-next', () => {
  class Variant {
    constructor(
      public type: string,
      public value: unknown
    ) {}
  }
  class Message {
    [key: string]: unknown
    constructor(options: Record<string, unknown>) {
      Object.assign(this, options)
    }
  }
  return {
    Variant,
    Message,
    sessionBus: () => ({
      on: (): void => {},
      // The portal request that never resolves.
      call: (): Promise<never> => new Promise<never>(() => {})
    })
  }
})

import { registerGlobalShortcutPortal } from '../../src/main/services/global-shortcut'

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('portal registration is bounded', () => {
  it('gives up and reports an unbound key when the portal never answers', async () => {
    const result = registerGlobalShortcutPortal('Ctrl+Shift+D', () => {})
    await vi.advanceTimersByTimeAsync(10_001)
    await expect(result).resolves.toBe(false)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('did not answer'))
  })
})
