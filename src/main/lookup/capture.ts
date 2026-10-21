import { app, screen, desktopCapturer, nativeImage } from 'electron'
import { join } from 'path/posix'
import { createWorker } from 'tesseract.js'
import type { Worker } from 'tesseract.js'
import type { LookupSession } from './state'
import { captureScreenViaPortal, isScreenCapturePortalPreferred } from '../services/screen-capture'

/* ---- OCR job queue ---- */
let tesseractWorker: Worker | null = null
let queue: Promise<unknown> = Promise.resolve()

/** Run queued tasks strictly one at a time; a rejection never poisons the chain. */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** Lazily create the shared tesseract worker. Only call from inside a queued task. */
async function ensureWorker(): Promise<Worker> {
  if (!tesseractWorker) {
    tesseractWorker = await createWorker('eng', 1, {
      cachePath: join(app.getPath('userData'), 'tesseract-cache'),
      logger: () => {}
    })
  }
  return tesseractWorker
}

/** Run OCR on a raw image buffer and return the recognized text. */
export async function ocrImageBuffer(imageBuffer: Buffer): Promise<string> {
  return runOCR(imageBuffer)
}

/* ---- Screen capture ---- */
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

/* ---- OCR jobs ---- */
export async function runOCR(imageBuffer: Buffer): Promise<string> {
  return enqueue(async () => {
    const worker = await ensureWorker()
    const result = await worker.recognize(imageBuffer)
    return result.data.text.trim()
  })
}

export async function runOCRTokenedFor(
  session: LookupSession,
  imageBuffer: Buffer
): Promise<string | null> {
  const token = ++session.ocrToken
  const text = await runOCR(imageBuffer)
  if (token !== session.ocrToken) return null
  return text
}

/** Terminate the current tesseract worker between jobs. Frees it for a new OCR job. */
export async function cancelOCR(): Promise<void> {
  await enqueue(async () => {
    const worker = tesseractWorker
    tesseractWorker = null
    if (!worker) return
    try {
      await worker.terminate()
    } catch {
      // worker may have been terminated already
    }
  })
}
