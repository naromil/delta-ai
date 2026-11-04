import { memo, useEffect, useRef, useState } from 'react'
import { flattenMarkdown } from '../../../../shared/rich-text'
import type { ExpansionNode } from '../../../../shared/rich-text'
import { attachmentSrc } from '../../lib/image-attachments'
import { isPlainMarkdown } from '../../lib/markdown'
import Markdown from './Markdown'

/** Screen point of the control that opened a popup, so the popup appears next to it. */
export type FramePopupAt = { x: number; y: number }

export interface ExpansionFrameActions {
  onFold: (id: number) => void
  onUnfold: (id: number) => void
  /** Fresh answer in place: Retry on a failed frame, Regenerate on a finished one. */
  onRetry?: (id: number) => void
  /** Change the question and get a fresh answer in place. */
  onEdit?: (id: number, at: FramePopupAt) => void
  onDismiss?: (id: number) => void
  /** Ask a new question about the same range; earlier answers stay in the list. */
  onAskAnother?: (id: number, at: FramePopupAt) => void
  /** Choose among the answers on this range. */
  onPickAnswer?: (id: number, at: FramePopupAt) => void
}

interface ExpansionFrameProps extends ExpansionFrameActions {
  node: ExpansionNode
  /** Every expansion on this range, including `node`. */
  group?: ExpansionNode[]
}

const COPIED_LABEL_MS = 1500

function handleActivationKey(e: React.KeyboardEvent, action: () => void): void {
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  e.stopPropagation()
  action()
}

function popupPointBelow(element: Element): FramePopupAt {
  const rect = element.getBoundingClientRect()
  return { x: rect.left, y: rect.bottom + 4 }
}

/** The target as written: a pill or header may show bold, code or a whole code block. */
export function OriginalText({ text }: { text: string }): React.JSX.Element {
  if (isPlainMarkdown(text)) return <>{text}</>
  return (
    <Markdown
      source={text}
      expansions={[]}
      inline
      anchored={false}
      onFold={() => {}}
      onUnfold={() => {}}
      renderExpansion={() => null}
    />
  )
}

/** Code and formulas stay readable next to their answer; words are replaced by it as usual. */
function isCodeOrMath(text: string): boolean {
  const trimmed = text.trim()
  return /^(```|~~~|\$|\\\(|\\\[)/.test(trimmed)
}

function FrameButton({
  label,
  title,
  onClick
}: {
  label: string
  title?: string
  onClick: (element: HTMLElement) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="frame-action"
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick(e.currentTarget)
      }}
    >
      {label}
    </button>
  )
}

/**
 * Inline expansion frame. The host element is always a `<span>`: in block mode
 * it sits inside a paragraph, and its answer is rendered in inline mode so no
 * block element ever nests inside it.
 *
 * Only one expansion of a range shows at a time. When a range holds several, its
 * pill and frame open a list of the answers instead of unfolding directly.
 */
function ExpansionFrame({ node, group, ...actions }: ExpansionFrameProps): React.JSX.Element {
  const { onFold, onUnfold, onRetry, onEdit, onDismiss, onAskAnother, onPickAnswer } = actions
  const bodyId = `expansion-body-${node.id}`
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<number | null>(null)
  const question = node.prompt?.trim() || null
  const answerCount = group?.length ?? 1

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    }
  }, [])

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(node.answer)
    } catch {
      return
    }
    setCopied(true)
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = window.setTimeout(() => {
      copiedTimerRef.current = null
      setCopied(false)
    }, COPIED_LABEL_MS)
  }

  if (node.folded) {
    const openPill = (element: Element): void => {
      if (answerCount > 1 && onPickAnswer) onPickAnswer(node.id, popupPointBelow(element))
      else onUnfold(node.id)
    }
    const flatOriginal = flattenMarkdown(node.originalText).slice(0, 80)
    return (
      <span
        className="queried"
        data-expansion-id={node.id}
        role="button"
        tabIndex={0}
        aria-expanded={false}
        aria-label={`Expand ${flatOriginal}${question ? `: ${question}` : ''}`}
        title={
          question ?? (answerCount > 1 ? 'Click to choose an answer' : 'Click to expand again')
        }
        onClick={(e) => openPill(e.currentTarget)}
        onKeyDown={(e) => {
          const element = e.currentTarget
          handleActivationKey(e, () => openPill(element))
        }}
      >
        <OriginalText text={node.originalText} />
        {answerCount > 1 ? <span className="queried-count">{answerCount}</span> : null}
      </span>
    )
  }

  const pending = node.status === 'loading' && node.answer === ''
  const finished = node.status !== 'loading'
  const showSource = isCodeOrMath(node.originalText)
  const frameClass = [
    'frame expanded',
    node.status === 'loading' ? 'loading' : '',
    node.status === 'error' ? 'error' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <span className={frameClass} data-expansion-id={node.id}>
      <span className="frame-inner" id={bodyId}>
        {showSource ? (
          <span className="frame-source">
            <OriginalText text={node.originalText} />
          </span>
        ) : null}
        {question ? <span className="frame-question">{question}</span> : null}
        {node.attachments?.length ? (
          <span className="frame-attachments">
            {node.attachments.map((attachment, index) => (
              <img
                key={index}
                src={attachmentSrc(attachment)}
                alt={attachment.name}
                title={attachment.name}
              />
            ))}
          </span>
        ) : null}
        {pending ? (
          <span className="frame-placeholder">Thinking…</span>
        ) : (
          <Markdown
            source={node.answer}
            expansions={node.children}
            inline
            onFold={onFold}
            onUnfold={onUnfold}
            renderExpansion={(child, childGroup) => (
              <ExpansionFrameMemo node={child} group={childGroup} {...actions} />
            )}
          />
        )}
        {node.status === 'error' ? (
          <>
            {showSource ? null : (
              <span className="frame-term" title={flattenMarkdown(node.originalText)}>
                <OriginalText text={node.originalText} />
              </span>
            )}
            {node.error ? <span className="frame-error">{node.error}</span> : null}
          </>
        ) : null}
        <span className="frame-actions">
          <span
            className="fold-toggle"
            role="button"
            tabIndex={0}
            aria-label="Fold expansion"
            aria-expanded={true}
            aria-controls={bodyId}
            onClick={(e) => {
              e.stopPropagation()
              onFold(node.id)
            }}
            onKeyDown={(e) => handleActivationKey(e, () => onFold(node.id))}
            title="Fold"
          >
            ▾
          </span>
          {finished && onRetry ? (
            <FrameButton
              label={node.status === 'error' ? 'Retry' : 'Regenerate'}
              onClick={() => onRetry(node.id)}
            />
          ) : null}
          {finished && onEdit ? (
            <FrameButton
              label="Edit"
              title="Change the question and get a new answer"
              onClick={(element) => onEdit(node.id, popupPointBelow(element))}
            />
          ) : null}
          {finished && onAskAnother ? (
            <FrameButton
              label="Ask…"
              title="Ask something else about this; this answer stays available"
              onClick={(element) => onAskAnother(node.id, popupPointBelow(element))}
            />
          ) : null}
          {node.answer !== '' ? (
            <FrameButton label={copied ? 'Copied' : 'Copy'} onClick={() => void handleCopy()} />
          ) : null}
          {onDismiss ? <FrameButton label="Remove" onClick={() => onDismiss(node.id)} /> : null}
          {answerCount > 1 && onPickAnswer ? (
            <FrameButton
              label={`${answerCount} answers`}
              onClick={(element) => onPickAnswer(node.id, popupPointBelow(element))}
            />
          ) : null}
        </span>
      </span>
    </span>
  )
}

const ExpansionFrameMemo = memo(ExpansionFrame)

export default ExpansionFrameMemo
