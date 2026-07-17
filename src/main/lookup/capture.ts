import { app, screen, desktopCapturer, nativeImage } from 'electron'
import { join } from 'path/posix'
import { lookupState } from './state'
import { captureScreenViaPortal, isScreenCapturePortalPreferred } from '../services/screen-capture'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tesseractWorker: any = null

async function captureScreenImage(display: Electron.Display): Promise<Electron.NativeImage | null> {
  if (isScreenCapturePortalPreferred()) {
    const portalPng = await captureScreenViaPortal()
    if (portalPng && portalPng.length > 0) {
      const img = nativeImage.createFromBuffer(portalPng)
      if (!img.isEmpty()) return img
    }
  }

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: display.size.width, height: display.size.height }
  })

  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!source) return null

  const thumb = source.thumbnail
  if (thumb.isEmpty()) return null
  return thumb
}

export async function captureScreen(): Promise<Buffer | null> {
  const cursorPos = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursorPos)

  const image = await captureScreenImage(display)
  if (!image || image.isEmpty()) return null
  return image.toPNG()
}

export async function runOCR(imageBuffer: Buffer): Promise<string> {
  const Tesseract = await import('tesseract.js')

  if (!tesseractWorker) {
    tesseractWorker = await Tesseract.createWorker('eng', 1, {
      cachePath: join(app.getPath('userData'), 'tesseract-cache'),
      logger: () => {}
    })
  }

  const result = await tesseractWorker.recognize(imageBuffer)
  return result.data.text.trim()
}

export async function runOCRTokened(imageBuffer: Buffer): Promise<string | null> {
  const token = ++lookupState.lookupOcrToken
  const text = await runOCR(imageBuffer)
  if (token !== lookupState.lookupOcrToken) return null
  return text
}
