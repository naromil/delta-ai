import { useState, useEffect } from 'react'
import type { CategorizedKeyword, KeywordCategory } from '../../../../shared/models'

const CATEGORY_LABELS: Record<KeywordCategory, string> = {
  topic: 'Topics',
  knowledge_area: 'Knowledge',
  learning_preference: 'Preferences'
}

const CATEGORIES: KeywordCategory[] = ['topic', 'knowledge_area', 'learning_preference']

function HomeView(): React.JSX.Element {
  const [keywords, setKeywords] = useState<CategorizedKeyword[]>([])

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const { keywords: kw } = await window.api.kbLoadPrompt()
        if (!cancelled) setKeywords(kw)
      } catch {
        // ignore
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="view-shell">
      <div className="view-shell-header">
        <h1>Delta AI</h1>
      </div>
      <div className="view-shell-content">
        {keywords.length === 0 ? (
          <div className="home-empty">
            <h2 className="home-empty-title">No learning profile yet</h2>
            <p className="home-empty-text">
              Open <strong>Knowledge Base</strong> and choose <strong>Analyze</strong> to build a
              profile from your conversations. New topics and preferences will appear here.
            </p>
          </div>
        ) : (
          <div className="kb-home-columns">
            {CATEGORIES.map((cat) => {
              const group = keywords
                .filter((kw) => kw.category === cat)
                .sort((a, b) => b.count - a.count)

              return (
                <div key={cat} className={`kb-home-column kb-home-column--${cat}`}>
                  <span className="kb-home-column-label">{CATEGORY_LABELS[cat]}</span>
                  <div className="kb-home-column-tags">
                    {group.map((kw) => (
                      <div key={kw.keyword} className={`kb-home-tag kb-home-tag--${cat}`}>
                        <span className="kb-home-tag-keyword">{kw.keyword}</span>
                        <span className="kb-home-tag-count">{kw.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export default HomeView
