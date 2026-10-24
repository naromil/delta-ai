import { memo } from 'react'
import type { ExpansionNode } from '../../../../shared/rich-text'
import Markdown from './Markdown'

interface ExpansionFrameProps {
  node: ExpansionNode
  onFold: (id: number) => void
  onUnfold: (id: number) => void
  onRetry?: (id: number) => void
  onDismiss?: (id: number) => void
}

function handleActivationKey(e: React.KeyboardEvent, action: () => void): void {
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  e.stopPropagation()
  action()
}

function renderChild(
  child: ExpansionNode,
  onFold: (id: number) => void,
  onUnfold: (id: number) => void,
  onRetry?: (id: number) => void,
  onDismiss?: (id: number) => void
): React.ReactNode {
  return (
    <ExpansionFrame
      node={child}
      onFold={onFold}
      onUnfold={onUnfold}
      onRetry={onRetry}
      onDismiss={onDismiss}
    />
  )
}

/**
 * Inline expansion frame. The host element is always a `<span>`: in block mode
 * it sits inside a paragraph, and its answer is rendered in inline mode so no
 * block element ever nests inside it.
 *
 * An errored frame keeps the fold toggle (folding restores `originalText` into
 * the text flow) and offers Retry / Dismiss.
 */
function ExpansionFrame({
  node,
  onFold,
  onUnfold,
  onRetry,
  onDismiss
}: ExpansionFrameProps): React.JSX.Element {
  const bodyId = `expansion-body-${node.id}`

  if (node.folded) {
    return (
      <span
        className="queried"
        data-expansion-id={node.id}
        role="button"
        tabIndex={0}
        aria-expanded={false}
        aria-label={`Expand ${node.originalText}`}
        title="Click to expand again"
        onClick={() => onUnfold(node.id)}
        onKeyDown={(e) => handleActivationKey(e, () => onUnfold(node.id))}
      >
        {node.originalText}
      </span>
    )
  }

  const pending = node.status === 'loading' && node.answer === ''
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
        {pending ? (
          <span className="frame-placeholder">Thinking…</span>
        ) : (
          <Markdown
            source={node.answer}
            expansions={node.children}
            inline
            onFold={onFold}
            onUnfold={onUnfold}
            renderExpansion={(child) => renderChild(child, onFold, onUnfold, onRetry, onDismiss)}
          />
        )}
        {node.status === 'error' ? (
          <>
            <span className="frame-term" title={node.originalText}>
              {node.originalText}
            </span>
            {node.error ? <span className="frame-error">{node.error}</span> : null}
            <span className="frame-actions">
              {onRetry ? (
                <button
                  type="button"
                  className="frame-action"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRetry(node.id)
                  }}
                >
                  Retry
                </button>
              ) : null}
              {onDismiss ? (
                <button
                  type="button"
                  className="frame-action"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDismiss(node.id)
                  }}
                >
                  Dismiss
                </button>
              ) : null}
            </span>
          </>
        ) : null}
      </span>
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
    </span>
  )
}

export default memo(ExpansionFrame)
