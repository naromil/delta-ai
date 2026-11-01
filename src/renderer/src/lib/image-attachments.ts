import type { ImageAttachment } from '../../../shared/attachments'
import {
  MAX_ATTACHMENT_NAME_LENGTH,
  isSupportedImageType,
  scaledImageSize
} from '../../../shared/attachments'

const OUTPUT_TYPE = 'image/jpeg'
const OUTPUT_QUALITY = 0.85
/** Refuse before decoding: a huge file would stall the window just to be scaled down. */
const MAX_SOURCE_BYTES = 30 * 1024 * 1024

function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image.'))
    reader.readAsDataURL(blob)
  })
}

/**
 * Decodes, scales and re-encodes an image to a JPEG. Re-encoding keeps records and
 * requests small, gives every provider a format it accepts, and strips metadata such
 * as EXIF GPS coordinates before anything leaves the machine.
 */
export async function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  if (!isSupportedImageType(file.type)) {
    throw new Error(`${file.name || 'That file'} is not a PNG, JPEG, WebP or GIF image.`)
  }
  if (file.size > MAX_SOURCE_BYTES) throw new Error(`${file.name} is too large (30 MB limit).`)

  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    const { width, height } = scaledImageSize(bitmap.width, bitmap.height)
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not process the image.')
    // JPEG has no alpha; transparent screenshots would otherwise turn black.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(bitmap, 0, 0, width, height)
    const blob = await canvas.convertToBlob({ type: OUTPUT_TYPE, quality: OUTPUT_QUALITY })
    return {
      name: (file.name || 'image').slice(0, MAX_ATTACHMENT_NAME_LENGTH),
      mediaType: OUTPUT_TYPE,
      data: await readBase64(blob)
    }
  } finally {
    bitmap.close()
  }
}

export function attachmentSrc(attachment: ImageAttachment): string {
  return `data:${attachment.mediaType};base64,${attachment.data}`
}
