import type { ImageInput } from './models'

/** An image on a user turn. Stored inline in the conversation record, base64 encoded. */
export interface ImageAttachment extends ImageInput {
  name: string
}

/** What a provider receives of an attachment: the name stays on the record. */
export function attachmentImages(attachments: ImageAttachment[] | undefined): ImageInput[] {
  return (attachments ?? []).map(({ mediaType, data }) => ({ mediaType, data }))
}

export const MAX_ATTACHMENTS_PER_MESSAGE = 4
/** Long-edge limit the renderer scales to; also keeps records and requests small. */
export const MAX_IMAGE_EDGE = 1568
/** Upper bound main accepts per image. The renderer's re-encoded output stays far below it. */
export const MAX_IMAGE_BASE64_CHARS = 8 * 1024 * 1024
export const MAX_ATTACHMENT_NAME_LENGTH = 255

/** SVG is deliberately absent: it is a document format, not an image a model can read. */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

export function isSupportedImageType(mediaType: string): boolean {
  return IMAGE_MEDIA_TYPES.has(mediaType)
}

export function isImageInput(value: unknown): value is ImageInput {
  if (typeof value !== 'object' || value === null) return false
  const { mediaType, data } = value as Record<string, unknown>
  return (
    typeof mediaType === 'string' &&
    isSupportedImageType(mediaType) &&
    typeof data === 'string' &&
    data.length <= MAX_IMAGE_BASE64_CHARS &&
    BASE64.test(data)
  )
}

export function isImageAttachment(value: unknown): value is ImageAttachment {
  if (!isImageInput(value)) return false
  const { name } = value as unknown as Record<string, unknown>
  return typeof name === 'string' && name.length <= MAX_ATTACHMENT_NAME_LENGTH
}

/** Fits `width`×`height` inside `maxEdge`, keeping the aspect ratio; never upscales. */
export function scaledImageSize(
  width: number,
  height: number,
  maxEdge: number = MAX_IMAGE_EDGE
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { width, height }
  const ratio = maxEdge / longest
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio))
  }
}
