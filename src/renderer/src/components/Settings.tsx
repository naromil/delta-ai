import { useState } from 'react'

type Provider = {
  name: string
  key: string
  endpoint: string
  model: string
}

const DEFAULT_PROVIDERS: Provider[] = [
  { name: 'OpenAI', key: '', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { name: 'Anthropic', key: '', endpoint: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet' },
  { name: 'Google AI', key: '', endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash' },
  { name: 'Together AI', key: '', endpoint: 'https://api.together.xyz/v1', model: 'mistral-7b' },
  { name: 'DeepSeek', key: '', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'Ollama (local)', key: '', endpoint: 'http://localhost:11434/v1', model: 'llama3' }
]

interface SettingsProps {
  onBack: () => void
}

function Settings({ onBack }: SettingsProps): React.JSX.Element {
  const [providers, setProviders] = useState<Provider[]>(() => {
    try {
      const saved = localStorage.getItem('delta-ai-providers')
      if (saved) return JSON.parse(saved)
    } catch {
      // ignore corrupted data
    }
    return DEFAULT_PROVIDERS
  })

  const [saved, setSaved] = useState(false)

  const updateField = (index: number, field: keyof Provider, value: string): void => {
    setProviders((prev) => {
      const next = prev.map((p, i) => (i === index ? { ...p, [field]: value } : p))
      return next
    })
    setSaved(false)
  }

  const handleSave = (): void => {
    localStorage.setItem('delta-ai-providers', JSON.stringify(providers))
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="settings">
      <div className="settings-header">
        <button className="settings-back" onClick={onBack} aria-label="Back to chat">
          <svg viewBox="0 0 24 24" className="icon" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h2 className="settings-title">API Configuration</h2>
      </div>
      <p className="settings-subtitle">
        Bring your own API keys. Keys are stored locally on your device.
      </p>
      <div className="settings-list">
        {providers.map((p, i) => (
          <div key={p.name} className="provider-card">
            <div className="provider-card-header">
              <span className="provider-name">{p.name}</span>
              {p.key && <span className="provider-status configured">• Configured</span>}
              {!p.key && <span className="provider-status unconfigured">• Not configured</span>}
            </div>
            <label className="provider-field">
              <span>API Key</span>
              <input
                type="password"
                className="settings-input"
                value={p.key}
                onChange={(e) => updateField(i, 'key', e.target.value)}
                placeholder="sk-..."
              />
            </label>
            <label className="provider-field">
              <span>Endpoint URL</span>
              <input
                type="text"
                className="settings-input"
                value={p.endpoint}
                onChange={(e) => updateField(i, 'endpoint', e.target.value)}
                placeholder="https://api.example.com/v1"
              />
            </label>
            <label className="provider-field">
              <span>Model</span>
              <input
                type="text"
                className="settings-input"
                value={p.model}
                onChange={(e) => updateField(i, 'model', e.target.value)}
                placeholder="model-name"
              />
            </label>
          </div>
        ))}
      </div>
      <div className="settings-footer">
        <button className="settings-save" onClick={handleSave}>
          {saved ? '✓ Saved' : 'Save Configuration'}
        </button>
      </div>
    </div>
  )
}

export default Settings