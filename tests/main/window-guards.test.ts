import { describe, expect, it, vi } from 'vitest'

const shell = vi.hoisted(() => ({ openExternal: vi.fn(async () => undefined) }))

vi.mock('electron', () => ({ shell }))

import { guardWindowNavigation, isSafeExternalUrl } from '../../src/main/window-guards'
import type { BrowserWindow } from 'electron'

function fakeWindow(currentUrl: string): {
  window: BrowserWindow
  openHandler: () => (details: { url: string }) => { action: string }
  navigate: (url: string) => { prevented: boolean }
} {
  let openHandler: ((details: { url: string }) => { action: string }) | null = null
  let navigateListener: ((event: { preventDefault: () => void }, url: string) => void) | null = null
  const webContents = {
    getURL: () => currentUrl,
    setWindowOpenHandler: (handler: typeof openHandler) => {
      openHandler = handler
    },
    on: (channel: string, listener: typeof navigateListener) => {
      if (channel === 'will-navigate') navigateListener = listener
    }
  }
  return {
    window: { webContents } as unknown as BrowserWindow,
    openHandler: () => openHandler!,
    navigate: (url) => {
      const event = { prevented: false, preventDefault: () => (event.prevented = true) }
      navigateListener!(event, url)
      return event
    }
  }
}

describe('isSafeExternalUrl', () => {
  it('only allows http(s)', () => {
    expect(isSafeExternalUrl('https://example.com')).toBe(true)
    expect(isSafeExternalUrl('http://example.com')).toBe(true)
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('not a url')).toBe(false)
  })
})

describe('guardWindowNavigation', () => {
  it('denies every new window and hands safe links to the system browser', () => {
    shell.openExternal.mockClear()
    const fake = fakeWindow('file:///app/index.html?role=lookup')
    guardWindowNavigation(fake.window)

    expect(fake.openHandler()({ url: 'https://evil.example' })).toEqual({ action: 'deny' })
    expect(shell.openExternal).toHaveBeenCalledWith('https://evil.example')

    expect(fake.openHandler()({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(shell.openExternal).toHaveBeenCalledTimes(1)
  })

  it('blocks in-window navigation away from the bundle', () => {
    shell.openExternal.mockClear()
    const fake = fakeWindow('file:///app/index.html?role=lookup')
    guardWindowNavigation(fake.window)

    expect(fake.navigate('https://evil.example').prevented).toBe(true)
    expect(shell.openExternal).toHaveBeenCalledWith('https://evil.example')
    expect(fake.navigate('file:///app/index.html?role=lookup').prevented).toBe(false)
  })
})
