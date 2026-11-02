import { useState, useEffect, useRef } from 'react'
import type { KbMaintenanceStatus } from '../../../../shared/kb'

const MINUTE_MS = 60_000

function formatElapsed(iso: string): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return 'recently'
  const minutes = Math.max(0, Math.round((Date.now() - then) / MINUTE_MS))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/** One sentence explaining what the background loop is doing, and why. */
function describeStatus(status: KbMaintenanceStatus | null): string {
  if (!status) return 'Automatic learning status unavailable.'
  if (!status.configured) {
    return 'Assign a model to Knowledge Base Maintenance to learn automatically.'
  }
  if (!status.enabled) {
    return 'Automatic learning is off — turn it on in Settings → General.'
  }
  if (status.state === 'running') return 'Learning from your conversations…'
  if (status.pending > 0) {
    const pending = `${status.pending} conversation${status.pending === 1 ? '' : 's'}`
    return `${pending} queued for automatic learning`
  }
  if (status.lastLearnedAt) return `Memories updated ${formatElapsed(status.lastLearnedAt)}`
  return 'Automatic learning is on — memories build as you chat.'
}

function KnowledgeView(): React.JSX.Element {
  const [status, setStatus] = useState<KbMaintenanceStatus | null>(null)
  const [totalCount, setTotalCount] = useState<number>(0)
  const [loadingAnalyze, setLoadingAnalyze] = useState<boolean>(false)
  const [loadingReanalyze, setLoadingReanalyze] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<string | null>(null)
  const [showReanalyzeInput, setShowReanalyzeInput] = useState<boolean>(false)
  const [reanalyzeCount, setReanalyzeCount] = useState<string>('')
  const reanalyzeInputRef = useRef<HTMLInputElement>(null)
  const statusVersionRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    const version = statusVersionRef.current
    async function load(): Promise<void> {
      try {
        const [all, kbStatus] = await Promise.all([
          window.api.listConversations(),
          window.api.kbGetStatus()
        ])
        if (cancelled) return
        setTotalCount(all.length)
        // A pushed status landed while this snapshot was in flight; the
        // subscription owns the display from now on.
        if (statusVersionRef.current !== version) return
        setStatus(kbStatus)
      } catch {
        // ignore
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  /* Follow the background loop: it can finish a pass while this view is open. */
  useEffect(() => {
    let cancelled = false
    const unsubscribe = window.api.kbOnStatus((next) => {
      if (cancelled) return
      statusVersionRef.current += 1
      setStatus(next)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const refreshCounts = async (): Promise<void> => {
    const [all, kbStatus] = await Promise.all([
      window.api.listConversations(),
      window.api.kbGetStatus()
    ])
    setStatus(kbStatus)
    setTotalCount(all.length)
  }

  const handleAnalyze = async (): Promise<void> => {
    setLoadingAnalyze(true)
    setError(null)
    setLastResult(null)
    try {
      const result = await window.api.kbAnalyze()
      if (result.conversationsAnalyzed === 0) {
        setLastResult('No unfed conversations to analyze.')
      } else {
        setLastResult(`Analyzed ${result.conversationsAnalyzed} conversation(s).`)
      }
      await refreshCounts()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingAnalyze(false)
    }
  }

  const startReanalyze = (): void => {
    setShowReanalyzeInput(true)
    setTimeout(() => reanalyzeInputRef.current?.focus(), 0)
  }

  const confirmReanalyze = async (): Promise<void> => {
    const n = parseInt(reanalyzeCount, 10)
    if (isNaN(n) || n < 1) return
    const reanalyzeLimit = Math.min(n, totalCount)

    setShowReanalyzeInput(false)
    setReanalyzeCount('')
    setLoadingReanalyze(true)
    setError(null)
    setLastResult(null)
    try {
      const result = await window.api.kbReanalyze(reanalyzeLimit)
      if (result.conversationsAnalyzed === 0) {
        setLastResult('No conversations found.')
      } else {
        setLastResult(`Re-analyzed ${result.conversationsAnalyzed} conversation(s).`)
      }
      await refreshCounts()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingReanalyze(false)
    }
  }

  const busy = loadingAnalyze || loadingReanalyze
  const autoRunning = status?.state === 'running'
  const pendingCount = status?.pending ?? 0

  return (
    <div className="view-shell">
      <div className="view-shell-header">
        <h1>Knowledge Base</h1>
      </div>
      <div className="view-shell-content">
        <div className="kb-status-bar">
          <span className="kb-status-text">{describeStatus(status)}</span>
          <div className="kb-buttons">
            <button
              className="btn btn--primary"
              disabled={busy || autoRunning || pendingCount === 0}
              onClick={handleAnalyze}
            >
              {loadingAnalyze ? 'Analyzing...' : 'Analyze now'}
            </button>
            <button
              className="btn"
              disabled={busy || autoRunning || totalCount === 0}
              onClick={startReanalyze}
            >
              {loadingReanalyze ? 'Re-analyzing...' : 'Re-Analyze'}
            </button>
          </div>
        </div>

        {showReanalyzeInput && (
          <div className="kb-reanalyze-prompt">
            <label htmlFor="reanalyze-count">Re-analyze the most recent </label>
            <input
              id="reanalyze-count"
              ref={reanalyzeInputRef}
              className="kb-reanalyze-input"
              type="number"
              min={1}
              max={totalCount}
              value={reanalyzeCount}
              onChange={(e) => setReanalyzeCount(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmReanalyze()
                if (e.key === 'Escape') {
                  setShowReanalyzeInput(false)
                  setReanalyzeCount('')
                }
              }}
            />
            <span> conversation(s).</span>
            <button className="btn btn--primary btn--sm" onClick={confirmReanalyze}>
              Go
            </button>
            <button
              className="btn btn--sm"
              onClick={() => {
                setShowReanalyzeInput(false)
                setReanalyzeCount('')
              }}
            >
              Cancel
            </button>
          </div>
        )}

        {error && <p className="kb-error">{error}</p>}
        {!error && status?.lastError && !autoRunning && (
          <p className="kb-error">Automatic learning failed: {status.lastError}</p>
        )}
        {lastResult && <p className="kb-result">{lastResult}</p>}

        <p className="kb-section-desc">
          Delta AI keeps private markdown notes about you and uses them to personalize chats and
          look-ups. Analyze now curates chats still in the queue; Re-Analyze goes over recent chats
          again.
        </p>
      </div>
    </div>
  )
}

export default KnowledgeView
