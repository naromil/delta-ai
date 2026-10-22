import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  PICKER_LIMIT,
  commitPickerValue,
  filterPickerModels,
  initialPickerState,
  reducePickerState
} from '../../../../../shared/model-picker'
import type { PickerEvent, PickerModel, PickerState } from '../../../../../shared/model-picker'

interface ModelPickerProps {
  models: PickerModel[]
  value: string
  onChange: (model: string) => void
  disabled?: boolean
  placeholder?: string
}

/** Height of the list when there is room for it; the footer sits below this. */
const LIST_MAX_HEIGHT = 260

/** Space the dropdown needs for its footer and borders. */
const DROPDOWN_CHROME = 44

/** Below this much room the dropdown is better off opening upwards. */
const MIN_ROOM_BELOW = 180

function ModelPicker({
  models,
  value,
  onChange,
  disabled,
  placeholder = 'Search or enter a model ID…'
}: ModelPickerProps): React.JSX.Element {
  const [state, setState] = useState<PickerState>(initialPickerState)
  const [placement, setPlacement] = useState<{ up: boolean; listHeight: number }>({
    up: false,
    listHeight: LIST_MAX_HEIGHT
  })
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listboxId = useId()

  const filtered = filterPickerModels(models, state.query)
  const visible = filtered.slice(0, PICKER_LIMIT)
  const customValue = state.query.trim()
  const showCustomRow = visible.length === 0 && customValue.length > 0

  const dispatch = useCallback(
    (event: PickerEvent): void => {
      setState((current) => reducePickerState(current, event, visible.length))
    },
    [visible.length]
  )

  const commit = useCallback(
    (model: string | null): void => {
      if (model !== null) onChange(model)
      dispatch({ type: 'close' })
    },
    [onChange, dispatch]
  )

  useEffect(() => {
    if (!state.open) return
    const handleMouseDown = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) {
        dispatch({ type: 'close' })
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [state.open, dispatch])

  // Keep the list inside the window: a 260px dropdown under a field near the bottom of a
  // 640px-tall window would otherwise be clipped and hide its own footer count.
  useEffect(() => {
    if (!state.open) return
    const measure = (): void => {
      const input = inputRef.current
      if (!input) return
      const rect = input.getBoundingClientRect()
      const below = window.innerHeight - rect.bottom - 12
      const above = rect.top - 12
      const up = below < MIN_ROOM_BELOW && above > below
      const room = Math.max((up ? above : below) - DROPDOWN_CHROME, 120)
      setPlacement({ up, listHeight: Math.min(LIST_MAX_HEIGHT, room) })
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [state.open])

  const handleFocus = (): void => {
    if (!state.open) dispatch({ type: 'open' })
  }

  // A closed picker keeps focus after Escape, so `focus` never fires again; open on the
  // click itself or the field looks dead until the user starts typing into a stale value.
  const handleMouseDown = (): void => {
    if (!state.open) dispatch({ type: 'open' })
  }

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    dispatch({ type: 'query', value: event.target.value })
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!state.open) {
        dispatch({ type: 'open' })
      } else {
        dispatch({ type: 'move', delta: event.key === 'ArrowDown' ? 1 : -1 })
      }
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (state.open) commit(commitPickerValue(state, visible))
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      dispatch({ type: 'close' })
      return
    }
    if (event.key === 'Tab') {
      dispatch({ type: 'close' })
    }
  }

  const highlightedIndex = Math.min(state.highlight, Math.max(visible.length - 1, 0))
  const activeDescendant = state.open
    ? showCustomRow
      ? `${listboxId}-option-custom`
      : visible.length > 0
        ? `${listboxId}-option-${highlightedIndex}`
        : undefined
    : undefined

  return (
    <div className="model-picker" ref={containerRef}>
      <input
        ref={inputRef}
        type="text"
        className="settings-input model-picker-input"
        role="combobox"
        aria-label="Model"
        aria-autocomplete="list"
        aria-expanded={state.open}
        aria-controls={`${listboxId}-listbox`}
        aria-activedescendant={activeDescendant}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        placeholder={placeholder}
        value={state.open ? state.query : value}
        onFocus={handleFocus}
        onMouseDown={handleMouseDown}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />
      {state.open && (
        <div className={`model-picker-dropdown${placement.up ? ' model-picker-dropdown--up' : ''}`}>
          <ul
            id={`${listboxId}-listbox`}
            className="model-picker-list"
            style={{ maxHeight: placement.listHeight }}
            role="listbox"
            aria-label="Models"
          >
            {visible.map((model, index) => (
              <li
                key={model.id}
                id={`${listboxId}-option-${index}`}
                role="option"
                aria-selected={index === state.highlight}
                className={`model-picker-option${
                  index === state.highlight ? ' model-picker-option--active' : ''
                }`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commit(model.id)}
              >
                <span className="model-picker-id">{model.id}</span>
                {model.hint && <span className="model-picker-hint">{model.hint}</span>}
              </li>
            ))}
            {showCustomRow && (
              <li
                id={`${listboxId}-option-custom`}
                role="option"
                aria-selected={true}
                className="model-picker-option model-picker-option--active"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commit(customValue)}
              >
                <span className="model-picker-id">Use “{customValue}”</span>
              </li>
            )}
          </ul>
          <div className="model-picker-footer" aria-live="polite">
            {visible.length} of {models.length}
          </div>
        </div>
      )}
    </div>
  )
}

export default ModelPicker
