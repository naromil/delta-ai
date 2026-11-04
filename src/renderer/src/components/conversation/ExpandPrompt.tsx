import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ImageAttachment } from '../../../../shared/attachments'
import { MAX_ATTACHMENTS_PER_MESSAGE } from '../../../../shared/attachments'
import { EXPAND_INTENTS } from '../../../../shared/prompts'
import { useImageAttachments } from '../../hooks/useImageAttachments'
import { attachmentSrc } from '../../lib/image-attachments'

export interface ExpandPromptState {
  x: number
  y: number
  onSubmit: (prompt: string, attachments: ImageAttachment[]) => void
  /** Present when editing an existing question. */
  initialPrompt?: string
  /** Offers the same image input as the composer. */
  allowImages?: boolean
}

interface ExpandPromptProps {
  state: ExpandPromptState | null
  onClose: () => void
}

function ExpandPromptPanel({
  state,
  onClose
}: {
  state: ExpandPromptState
  onClose: () => void
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [attachments, setAttachments] = useState<ImageAttachment[]>([])
  const allowImages = state.allowImages === true
  const { notice, busy, addFiles } = useImageAttachments(
    attachments,
    allowImages ? setAttachments : undefined
  )

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const rect = panel.getBoundingClientRect()
    setPosition({
      x: Math.max(8, Math.min(state.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(state.y, window.innerHeight - rect.height - 8))
    })
  }, [state, attachments.length, notice])

  useEffect(() => {
    const focusTimer = setTimeout(() => {
      inputRef.current?.focus()
      if (state.initialPrompt) inputRef.current?.select()
    }, 0)

    const handleMouseDown = (e: MouseEvent): void => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }

    document.addEventListener('mousedown', handleMouseDown, true)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      clearTimeout(focusTimer)
      document.removeEventListener('mousedown', handleMouseDown, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [state, onClose])

  const editing = state.initialPrompt !== undefined

  const submit = (prompt: string): void => {
    if (busy) return
    state.onSubmit(prompt, attachments)
    onClose()
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>): void => {
    if (!allowImages) return
    const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
    if (images.length === 0) return
    e.preventDefault()
    void addFiles(images)
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!allowImages) return
    e.preventDefault()
    void addFiles(Array.from(e.dataTransfer.files))
  }

  return (
    <div
      ref={panelRef}
      id="expandPrompt"
      className="visible"
      style={{ left: (position ?? state).x, top: (position ?? state).y }}
      onDragOver={allowImages ? (e) => e.preventDefault() : undefined}
      onDrop={handleDrop}
    >
      {attachments.length > 0 ? (
        <div className="composer-attachments">
          {attachments.map((attachment, index) => (
            <div key={index} className="composer-attachment">
              <img src={attachmentSrc(attachment)} alt={attachment.name} title={attachment.name} />
              <button
                type="button"
                className="composer-attachment-remove"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="expand-prompt-row">
        <input
          ref={inputRef}
          type="text"
          className="expand-prompt-input"
          placeholder={editing ? 'Blank for a plain explanation' : 'Expand on…'}
          aria-label={editing ? 'Edit question' : 'Expand on'}
          autoComplete="off"
          defaultValue={state.initialPrompt}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit(inputRef.current?.value ?? '')
            }
          }}
        />
        {allowImages ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []))
                // Picking the same file twice must fire `change` again.
                e.target.value = ''
              }}
            />
            <button
              type="button"
              className="composer-attach"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy || attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
              aria-label="Attach images"
              title="Attach images"
            >
              <svg
                viewBox="0 0 24 24"
                className="icon"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
          </>
        ) : null}
      </div>
      {notice ? (
        <p className="expand-prompt-notice" role="status">
          {notice}
        </p>
      ) : null}
      {editing ? null : (
        <div className="expand-intents">
          {EXPAND_INTENTS.map((intent) => (
            <button
              key={intent.label}
              type="button"
              className="expand-intent"
              title={intent.prompt}
              onClick={() => submit(intent.prompt)}
            >
              {intent.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** A new position is a new prompt, so its draft images and text start empty. */
function ExpandPrompt({ state, onClose }: ExpandPromptProps): React.JSX.Element | null {
  if (!state) return null
  return <ExpandPromptPanel key={`${state.x}:${state.y}`} state={state} onClose={onClose} />
}

export default ExpandPrompt
