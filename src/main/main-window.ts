import { BrowserWindow } from 'electron'

let mainWindow: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win
}

/** Drops the ref once the window is gone, so callers never see a destroyed one. */
export function clearMainWindow(): void {
  mainWindow = null
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}
