import { useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasOutlineKind, CanvasOutlineRow } from '../../../../shared/canvas-outline'
import { searchCanvasOutline } from '../../../../shared/canvas-outline'
import type { CanvasIconName } from './CanvasIcons'
import CanvasIcon from './CanvasIcons'

const KIND_ICON: Readonly<Record<CanvasOutlineKind, CanvasIconName | null>> = {
  frame: 'frame',
  note: 'note',
  message: null,
  expansion: null
}

interface CanvasOutlineProps {
  rows: CanvasOutlineRow[]
  selectedIds: ReadonlySet<string>
  /** Cards with an answer being written. */
  streamingIds: ReadonlySet<string>
  /** Asked for the search box to take focus; changes each time it is asked. */
  focusRequest: number
  onSearchMatches: (ids: ReadonlySet<string> | null) => void
  onGoTo: (id: string) => void
  onClose: () => void
}

/** Every card as a list: click to go there, or type to find a card and dim the rest. */
function CanvasOutline({
  rows,
  selectedIds,
  streamingIds,
  focusRequest,
  onSearchMatches,
  onGoTo,
  onClose
}: CanvasOutlineProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searching = query.trim() !== ''
  const hits = useMemo(() => searchCanvasOutline(rows, query), [query, rows])
  const shown = searching ? hits : rows

  const hitKey = hits.map((hit) => hit.id).join(' ')
  useEffect(() => {
    onSearchMatches(searching ? new Set(hitKey === '' ? [] : hitKey.split(' ')) : null)
  }, [hitKey, onSearchMatches, searching])

  useEffect(() => () => onSearchMatches(null), [onSearchMatches])

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
    inputRef.current?.select()
  }, [focusRequest])

  useEffect(() => {
    listRef.current
      ?.querySelector('.canvas-outline-row.is-active')
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const step = (direction: 1 | -1): void => {
    if (shown.length === 0) return
    const next = (activeIndex + direction + shown.length) % shown.length
    setActiveIndex(next)
    if (searching) onGoTo(shown[next].id)
  }

  return (
    <aside className="canvas-outline" aria-label="Canvas outline">
      <div className="canvas-outline-search">
        <CanvasIcon name="search" />
        <input
          ref={inputRef}
          aria-label="Search this canvas"
          placeholder="Search this canvas"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActiveIndex(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              step(1)
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              step(-1)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              if (e.shiftKey) step(-1)
              else if (shown[activeIndex]) onGoTo(shown[activeIndex].id)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              if (searching) setQuery('')
              else onClose()
            }
          }}
        />
        {searching ? (
          <span className="canvas-outline-count" role="status">
            {hits.length === 0
              ? 'None'
              : `${Math.min(activeIndex + 1, hits.length)}/${hits.length}`}
          </span>
        ) : null}
      </div>
      <div ref={listRef} className="canvas-outline-list">
        {shown.length === 0 ? (
          <p className="canvas-outline-empty">
            {searching ? 'Nothing on this canvas matches.' : 'Nothing on this canvas yet.'}
          </p>
        ) : null}
        {shown.map((row, index) => {
          const icon = KIND_ICON[row.kind]
          const snippet = 'snippet' in row ? (row.snippet as string | undefined) : undefined
          return (
            <button
              key={row.id}
              type="button"
              className={[
                'canvas-outline-row',
                `canvas-outline-row--${row.kind}`,
                selectedIds.has(row.id) ? 'is-selected' : '',
                index === activeIndex ? 'is-active' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              data-color={row.color}
              style={{ paddingLeft: 10 + (searching ? 0 : row.depth) * 14 }}
              title={row.label}
              onClick={() => {
                setActiveIndex(index)
                onGoTo(row.id)
              }}
            >
              <span className="canvas-outline-mark" aria-hidden="true">
                {icon ? <CanvasIcon name={icon} /> : null}
              </span>
              <span className="canvas-outline-text">
                <span className="canvas-outline-label">{row.label}</span>
                {snippet ? <span className="canvas-outline-snippet">{snippet}</span> : null}
              </span>
              {streamingIds.has(row.id) ? (
                <span className="canvas-outline-writing" aria-label="Writing" />
              ) : null}
            </button>
          )
        })}
      </div>
    </aside>
  )
}

export default CanvasOutline
