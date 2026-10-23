import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface ExpandPromptState {
  x: number
  y: number
  onSubmit: (prompt: string) => void
}

interface ExpandPromptProps {
  state: ExpandPromptState | null
  onClose: () => void
}

function ExpandPrompt({ state, onClose }: ExpandPromptProps): React.JSX.Element | null {
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!state || !panel) {
      setPosition(null)
      return
    }
    const rect = panel.getBoundingClientRect()
    setPosition({
      x: Math.max(8, Math.min(state.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(state.y, window.innerHeight - rect.height - 8))
    })
  }, [state])

  useEffect(() => {
    if (!state) return

    const focusTimer = setTimeout(() => inputRef.current?.focus(), 0)

    const handleMouseDown = (e: MouseEvent): void => {
      if (inputRef.current && !inputRef.current.contains(e.target as Node)) {
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

  if (!state) return null

  const handleSubmit = (): void => {
    const value = inputRef.current?.value ?? ''
    state.onSubmit(value)
    onClose()
  }

  return (
    <div
      ref={panelRef}
      id="expandPrompt"
      className="visible"
      style={{ left: (position ?? state).x, top: (position ?? state).y }}
    >
      <input
        ref={inputRef}
        type="text"
        className="expand-prompt-input"
        placeholder="Expand on…"
        autoComplete="off"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            handleSubmit()
          }
        }}
      />
    </div>
  )
}

export default ExpandPrompt
