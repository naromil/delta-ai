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
  if (status.lastLearnedAt) return `Learning profile updated ${formatElapsed(status.lastLearnedAt)}`
  return 'Automatic learning is on — the profile builds as you chat.'
}

function KnowledgeView(): React.JSX.Element {
  const [prompt, setPrompt] = useState<string>('')
  const [savedPrompt, setSavedPrompt] = useState<string>('')
  const [status, setStatus] = useState<KbMaintenanceStatus | null>(null)
  const [totalCount, setTotalCount] = useState<number>(0)
  const [loadingAnalyze, setLoadingAnalyze] = useState<boolean>(false)
  const [loadingReanalyze, setLoadingReanalyze] = useState<boolean>(false)
  const [loadingSave, setLoadingSave] = useState<boolean>(false)
  const [loadingReset, setLoadingReset] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<string | null>(null)
  const [showReanalyzeInput, setShowReanalyzeInput] = useState<boolean>(false)
  const [reanalyzeCount, setReanalyzeCount] = useState<string>('')
  const reanalyzeInputRef = useRef<HTMLInputElement>(null)
  const promptRef = useRef(prompt)
  const savedPromptRef = useRef(savedPrompt)
  const statusRef = useRef<KbMaintenanceStatus | null>(null)

  useEffect(() => {
    promptRef.current = prompt
  }, [prompt])

  useEffect(() => {
    savedPromptRef.current = savedPrompt
  }, [savedPrompt])

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const [{ prompt: p }, all, kbStatus] = await Promise.all([
          window.api.kbLoadPrompt(),
          window.api.listConversations(),
          window.api.kbGetStatus()
        ])
        if (cancelled) return
        setPrompt(p)
        setSavedPrompt(p)
        setTotalCount(all.length)
        setStatus(kbStatus)
        statusRef.current = kbStatus
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
    const unsubscribe = window.api.kbOnStatus((next) => {
      const previous = statusRef.current
      statusRef.current = next
      setStatus(next)

      // A finished pass rewrote prompt.txt. Adopt it unless the user is editing.
      if (next.lastLearnedAt && next.lastLearnedAt !== previous?.lastLearnedAt) {
        if (promptRef.current !== savedPromptRef.current) return
        window.api
          .kbLoadPrompt()
          .then(({ prompt: learned }) => {
            setPrompt(learned)
            setSavedPrompt(learned)
          })
          .catch(() => undefined)
      }
    })
    return () => unsubscribe()
  }, [])

  const refreshCounts = async (): Promise<void> => {
    const [all, kbStatus] = await Promise.all([
      window.api.listConversations(),
      window.api.kbGetStatus()
    ])
    setStatus(kbStatus)
    statusRef.current = kbStatus
    setTotalCount(all.length)
  }

  const handleAnalyze = async (): Promise<void> => {
    setLoadingAnalyze(true)
    setError(null)
    setLastResult(null)
    try {
      const result = await window.api.kbAnalyze()
      setPrompt(result.newPrompt)
      setSavedPrompt(result.newPrompt)
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
      setPrompt(result.newPrompt)
      setSavedPrompt(result.newPrompt)
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

  const handleSavePrompt = async (): Promise<void> => {
    setLoadingSave(true)
    setError(null)
    setLastResult(null)
    try {
      const result = await window.api.kbSavePrompt(prompt)
      setPrompt(result.prompt)
      setSavedPrompt(result.prompt)
      setLastResult('Prompt saved.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingSave(false)
    }
  }

  const handleReset = async (): Promise<void> => {
    if (
      !window.confirm(
        'Delete the generated prompt and keywords? Conversation history is kept, and automatic ' +
          'learning rebuilds the profile from it when enabled.'
      )
    ) {
      return
    }
    setLoadingReset(true)
    setError(null)
    setLastResult(null)
    try {
      const result = await window.api.kbReset()
      setPrompt(result.prompt)
      setSavedPrompt(result.prompt)
      await refreshCounts()
      setLastResult('Knowledge base reset. Conversations are ready to be learned again.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingReset(false)
    }
  }

  const busy = loadingAnalyze || loadingReanalyze || loadingSave || loadingReset
  const autoRunning = status?.state === 'running'
  const pendingCount = status?.pending ?? 0
  const promptDirty = prompt !== savedPrompt

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
              className="settings-header-save"
              disabled={busy || autoRunning || pendingCount === 0}
              onClick={handleAnalyze}
            >
              {loadingAnalyze ? 'Analyzing...' : 'Analyze now'}
            </button>
            <button
              className="settings-header-save"
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
            <button className="settings-header-save" onClick={confirmReanalyze}>
              Go
            </button>
            <button
              className="settings-header-save"
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

        <div className="kb-section">
          <div className="kb-section-header">
            <div>
              <h3 className="settings-section-title">Personalized Lookup Prompt</h3>
              <p className="kb-section-desc">
                Learned from your conversation history and applied to every look-up. It refines
                itself in the background; edits saved here are used as the baseline for the next
                update.
              </p>
            </div>
            <div className="kb-buttons">
              <button
                className="settings-header-save"
                disabled={busy || !promptDirty}
                onClick={handleSavePrompt}
              >
                {loadingSave ? 'Saving...' : 'Save prompt'}
              </button>
              <button
                className="settings-header-save kb-danger"
                disabled={busy}
                onClick={handleReset}
              >
                {loadingReset ? 'Resetting...' : 'Reset'}
              </button>
            </div>
          </div>
          <textarea
            className="settings-input kb-prompt-textarea"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={12}
            placeholder="Your learning profile appears here after a few conversations..."
            spellCheck={false}
          />
          {promptDirty && <p className="kb-dirty">Unsaved changes</p>}
        </div>
      </div>
    </div>
  )
}

export default KnowledgeView
