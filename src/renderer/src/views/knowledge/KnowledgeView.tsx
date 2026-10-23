import { useState, useEffect, useRef } from 'react'

function KnowledgeView(): React.JSX.Element {
  const [prompt, setPrompt] = useState<string>('')
  const [savedPrompt, setSavedPrompt] = useState<string>('')
  const [unfedCount, setUnfedCount] = useState<number>(0)
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

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const [{ prompt: p }, unfed, all] = await Promise.all([
          window.api.kbLoadPrompt(),
          window.api.listUnfedConversations(),
          window.api.listConversations()
        ])
        if (!cancelled) {
          setPrompt(p)
          setSavedPrompt(p)
          setUnfedCount(unfed.length)
          setTotalCount(all.length)
        }
      } catch {
        // ignore
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const refreshCounts = async (): Promise<void> => {
    const [unfed, all] = await Promise.all([
      window.api.listUnfedConversations(),
      window.api.listConversations()
    ])
    setUnfedCount(unfed.length)
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
        'Delete the generated prompt and keywords? Conversation history is kept and becomes ' +
          'available for analysis again.'
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
      setLastResult('Knowledge base reset. Conversations are ready to be analyzed again.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingReset(false)
    }
  }

  const busy = loadingAnalyze || loadingReanalyze || loadingSave || loadingReset
  const promptDirty = prompt !== savedPrompt

  return (
    <div className="view-shell">
      <div className="view-shell-header">
        <h1>Knowledge Base</h1>
      </div>
      <div className="view-shell-content">
        <div className="kb-status-bar">
          <span className="kb-status-text">
            {unfedCount > 0
              ? `${unfedCount} unfed conversation(s) ready for analysis`
              : 'All conversations analyzed'}
          </span>
          <div className="kb-buttons">
            <button
              className="settings-header-save"
              disabled={busy || unfedCount === 0}
              onClick={handleAnalyze}
            >
              {loadingAnalyze ? 'Analyzing...' : 'Analyze'}
            </button>
            <button
              className="settings-header-save"
              disabled={busy || totalCount === 0}
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
        {lastResult && <p className="kb-result">{lastResult}</p>}

        <div className="kb-section">
          <div className="kb-section-header">
            <div>
              <h3 className="settings-section-title">Personalized Lookup Prompt</h3>
              <p className="kb-section-desc">
                Generated by the Knowledge Base Maintenance model from your conversation history.
                You can revise it before the next look-up.
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
            placeholder="Run analysis to generate a personalized system prompt..."
            spellCheck={false}
          />
          {promptDirty && <p className="kb-dirty">Unsaved changes</p>}
        </div>
      </div>
    </div>
  )
}

export default KnowledgeView
