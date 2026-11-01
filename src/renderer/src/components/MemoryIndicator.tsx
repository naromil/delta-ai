import { useEffect, useState } from 'react'

const VISIBLE_MS = 4000

/**
 * Transient notice that the document base changed. A burst of writes restarts the
 * timer instead of stacking, so one pass reads as one update.
 */
function MemoryIndicator(): React.JSX.Element {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    let timer: number | undefined
    const unsubscribe = window.api.onMemoryUpdated(() => {
      setVisible(true)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setVisible(false), VISIBLE_MS)
    })
    return () => {
      unsubscribe()
      window.clearTimeout(timer)
    }
  }, [])

  // The live region stays mounted so screen readers announce its content appearing.
  return (
    <div className="memory-indicator-region" role="status">
      {visible && <div className="memory-indicator">Memory updated</div>}
    </div>
  )
}

export default MemoryIndicator
