import { useCallback } from 'react'
import type { ExpandableSegment } from '../../../../shared/conversation'

interface ExpansionFrameProps {
  segment: ExpandableSegment & { kind: 'expansion' }
  onFold: (id: number) => void
  onUnfold: (id: number) => void
  onContextMenu: (e: React.MouseEvent, segmentIndex: number) => void
}

function selectNodeContents(node: Node): void {
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  range.selectNodeContents(node)
  sel.removeAllRanges()
  sel.addRange(range)
}

function ExpansionFrame({
  segment,
  onFold,
  onUnfold,
  onContextMenu
}: ExpansionFrameProps): React.JSX.Element {
  const {
    folded,
    loading,
    error,
    cachedText,
    originalText,
    expansionId,
    segments: childSegments
  } = segment

  const handleTripleClick = useCallback((e: React.MouseEvent) => {
    if (e.detail === 3 && e.button === 0) {
      e.preventDefault()
      e.stopPropagation()
      const inner = (e.currentTarget as HTMLElement).querySelector('.frame-inner')
      selectNodeContents(inner || e.currentTarget)
    }
  }, [])

  if (folded) {
    return (
      <span
        className="queried"
        data-expansion-id={expansionId}
        title="Click to re-expand"
        onClick={() => onUnfold(expansionId)}
        onContextMenu={(e) => {
          e.stopPropagation()
          onContextMenu(e, -1)
        }}
      >
        {originalText}
      </span>
    )
  }

  const frameClass = ['frame expanded', loading ? 'loading' : '', error ? 'error' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <span
      className={frameClass}
      data-expansion-id={expansionId}
      onMouseDown={handleTripleClick}
      onContextMenu={(e) => {
        e.stopPropagation()
        onContextMenu(e, -1)
      }}
    >
      <span className="frame-inner">
        {loading && !cachedText ? (
          'Thinking\u2026'
        ) : (
          <InlineSegments
            segments={childSegments.length > 0 ? childSegments : tokenizeInline(cachedText)}
            onFold={onFold}
            onUnfold={onUnfold}
            onContextMenu={onContextMenu}
          />
        )}
      </span>
      {!error && (
        <span
          className="fold-toggle"
          onClick={(e) => {
            e.stopPropagation()
            onFold(expansionId)
          }}
          title="Fold"
        >
          ▾
        </span>
      )}
    </span>
  )
}

function tokenizeInline(text: string): ExpandableSegment[] {
  const parts = text.split(/(\s+)/)
  return parts.filter((p) => p !== '').map((part) => ({ kind: 'text' as const, text: part }))
}

interface InlineSegmentsProps {
  segments: ExpandableSegment[]
  onFold: (id: number) => void
  onUnfold: (id: number) => void
  onContextMenu: (e: React.MouseEvent, segmentIndex: number) => void
}

function InlineSegments({
  segments,
  onFold,
  onUnfold,
  onContextMenu
}: InlineSegmentsProps): React.JSX.Element {
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === 'text') {
          return (
            <span
              key={i}
              className="word"
              onContextMenu={(e) => {
                e.stopPropagation()
                onContextMenu(e, i)
              }}
            >
              {seg.text}
            </span>
          )
        }
        return (
          <ExpansionFrame
            key={seg.expansionId}
            segment={seg}
            onFold={onFold}
            onUnfold={onUnfold}
            onContextMenu={onContextMenu}
          />
        )
      })}
    </>
  )
}

export default ExpansionFrame
export { InlineSegments }
