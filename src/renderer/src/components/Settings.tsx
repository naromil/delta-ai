import { useState, useEffect } from 'react'

/* ---- Google AI Studio models ---- */
const GOOGLE_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.1-pro',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemma-4-31b-it',
  'Custom...'
] as const

type ProviderConfig = {
  provider: string
  apiKey: string
  model: string
}

interface SettingsProps {
  onBack: () => void
}

function Settings({ onBack }: SettingsProps): React.JSX.Element {
  const [selectedProvider, setSelectedProvider] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('gemini-3.5-flash')
  const [customModel, setCustomModel] = useState('')
  const [isCustomModel, setIsCustomModel] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  /* load existing config on mount */
  useEffect(() => {
    window.api.loadConfig().then((cfg) => {
      if (!cfg || typeof cfg !== 'object') return
      const c = cfg as Record<string, unknown>
      if (typeof c.provider === 'string' && c.provider) {
        setSelectedProvider(c.provider)
      }
      if (typeof c.apiKey === 'string' && c.apiKey) {
        setApiKey(c.apiKey)
      }
      if (typeof c.model === 'string' && c.model) {
        const known = (GOOGLE_MODELS as readonly string[]).slice(0, -1)
        if (known.includes(c.model)) {
          setModel(c.model)
          setIsCustomModel(false)
        } else {
          setCustomModel(c.model)
          setIsCustomModel(true)
        }
      }
    })
  }, [])

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    const finalModel = isCustomModel ? customModel.trim() : model
    const config: ProviderConfig = {
      provider: selectedProvider,
      apiKey,
      model: finalModel
    }
    const res = await window.api.saveConfig(config)
    setSaving(false)
    if (res.success) {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } else {
      alert('Failed to save configuration.')
    }
  }

  const canSave = selectedProvider !== ''

  return (
    <div className="settings">
      <div className="settings-header">
        <button className="settings-back" onClick={onBack} aria-label="Back to chat">
          <svg viewBox="0 0 24 24" className="icon" aria-hidden="true">
            <path
              d="M15 18l-6-6 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <h2 className="settings-title">Settings</h2>
      </div>

      {/* ---- Provider selector ---- */}
      <div className="settings-section">
        <label className="settings-label" htmlFor="provider-select">
          API keys
        </label>
        <select
          id="provider-select"
          className="settings-select"
          value={selectedProvider}
          onChange={(e) => {
            setSelectedProvider(e.target.value)
            setSaved(false)
          }}
        >
          <option value="" disabled>
            Select a provider…
          </option>
          <option value="google-ai-studio">Google AI Studio</option>
        </select>
      </div>

      {/* ---- Provider-specific fields (only Google AI Studio for now) ---- */}
      {selectedProvider === 'google-ai-studio' && (
        <div className="settings-section provider-config">
          <label className="settings-label" htmlFor="api-key-input">
            API Key
          </label>
          <input
            id="api-key-input"
            type="password"
            className="settings-input"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value)
              setSaved(false)
            }}
            placeholder="Enter your Google AI API key…"
          />

          <label className="settings-label" htmlFor="model-select">
            Model
          </label>
          <select
            id="model-select"
            className="settings-select"
            value={isCustomModel ? 'Custom...' : model}
            onChange={(e) => {
              if (e.target.value === 'Custom...') {
                setIsCustomModel(true)
              } else {
                setModel(e.target.value)
                setIsCustomModel(false)
              }
              setSaved(false)
            }}
          >
            {GOOGLE_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>

          {isCustomModel && (
            <input
              type="text"
              className="settings-input settings-input--custom"
              value={customModel}
              onChange={(e) => {
                setCustomModel(e.target.value)
                setSaved(false)
              }}
              placeholder="Enter custom model name…"
            />
          )}
        </div>
      )}

      {/* ---- Save ---- */}
      <div className="settings-footer">
        <button className="settings-save" onClick={handleSave} disabled={!canSave || saving}>
          {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save'}
        </button>
      </div>
    </div>
  )
}

export default Settings
