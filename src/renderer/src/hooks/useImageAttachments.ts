import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImageAttachment } from '../../../shared/attachments'
import { MAX_ATTACHMENTS_PER_MESSAGE } from '../../../shared/attachments'
import { fileToImageAttachment } from '../lib/image-attachments'

const NOTICE_TIMEOUT_MS = 5000

/** Adds files to the composer draft: capability check, slot limit, scaling, errors. */
export function useImageAttachments(
  attachments: ImageAttachment[],
  onChange: React.Dispatch<React.SetStateAction<ImageAttachment[]>> | undefined
): {
  notice: string | null
  busy: boolean
  addFiles: (files: File[]) => Promise<void>
} {
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const timerRef = useRef<number | null>(null)
  const countRef = useRef(attachments.length)

  useEffect(() => {
    countRef.current = attachments.length
  }, [attachments.length])

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  const showNotice = useCallback((message: string | null): void => {
    setNotice(message)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = message ? window.setTimeout(() => setNotice(null), NOTICE_TIMEOUT_MS) : null
  }, [])

  const addFiles = useCallback(
    async (files: File[]): Promise<void> => {
      if (!onChange || files.length === 0) return
      showNotice(null)
      setBusy(true)
      try {
        // Asked per attempt: the model can change in Settings while a draft waits.
        if ((await window.api.chatImageSupport('chat')) === 'no') {
          showNotice("The selected model can't read images. Choose a vision model in Settings.")
          return
        }
        const free = MAX_ATTACHMENTS_PER_MESSAGE - countRef.current
        if (files.length > free) {
          showNotice(`A message can carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} images.`)
        }
        const results = await Promise.allSettled(
          files.slice(0, Math.max(0, free)).map(fileToImageAttachment)
        )
        const added: ImageAttachment[] = []
        for (const result of results) {
          if (result.status === 'fulfilled') added.push(result.value)
          else {
            showNotice(
              result.reason instanceof Error ? result.reason.message : 'Could not read image.'
            )
          }
        }
        onChange((prev) => [...prev, ...added].slice(0, MAX_ATTACHMENTS_PER_MESSAGE))
      } catch (err) {
        showNotice(err instanceof Error ? err.message : 'Could not attach the image.')
      } finally {
        setBusy(false)
      }
    },
    [onChange, showNotice]
  )

  return { notice, busy, addFiles }
}
