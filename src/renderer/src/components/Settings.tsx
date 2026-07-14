import { useState, useEffect, useRef } from 'react'

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

type Category = 'general' | 'providers'

function Settings({ onBack }: SettingsProps): React.JSX.Element {
  const [activeCategory, setActiveCategory] = useState<Category>('general')
  const [selectedProvider, setSelectedProvider] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('gemini-3.5-flash')
  const [customModel, setCustomModel] = useState('')
  const [isCustomModel, setIsCustomModel] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [hotkey, setHotkey] = useState('Ctrl+Shift+D')
  const [capturingHotkey, setCapturingHotkey] = useState(false)
  const hotkeyRef = useRef(hotkey)

  /* load existing config + settings on mount */
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

    window.api.loadSettings().then((s) => {
      if (s?.hotkey) {
        setHotkey(s.hotkey)
        hotkeyRef.current = s.hotkey
      }
    })
  }, [])

  /* ---- Hotkey capture mode ----
   * Clicking the hotkey input toggles capture. While capturing, keystrokes
   * are translated into Electron accelerator format and stored in `hotkey`.
   * Normal text editing is disabled via readOnly.
   */
  const renderCombo = (e: React.KeyboardEvent<HTMLInputElement>): string => {
    const parts: string[] = []
    if (e.ctrlKey) parts.push('Ctrl')
    if (e.altKey) parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')
    if (e.metaKey) parts.push('Meta')
    const key = e.key
    // Ignore lone modifiers — wait for a full combo
    if (!['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
      parts.push(key.length === 1 ? key.toUpperCase() : key)
    }
    return parts.join('+')
  }

  const handleHotkeyKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!capturingHotkey) return
    e.preventDefault()
    e.stopPropagation()
    const combo = renderCombo(e)
    if (combo) {
      hotkeyRef.current = combo
      setHotkey(combo)
    }
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    const finalModel = isCustomModel ? customModel.trim() : model
    const config: ProviderConfig = {
      provider: selectedProvider,
      apiKey,
      model: finalModel
    }
    const saveCfgProm = window.api.saveConfig(config)
    const saveSettingsProm = window.api.saveSettings({ hotkey: hotkeyRef.current })
    const [cfgRes] = await Promise.all([saveCfgProm, saveSettingsProm])
    setSaving(false)
    if (cfgRes.success) {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } else {
      alert('Failed to save configuration.')
    }
  }

  const canSave = selectedProvider !== ''

  const renderCategoryContent = (): React.JSX.Element => {
    if (activeCategory === 'general') {
      return (
        <>
          {/* ---- Hotkey settings ---- */}
          <div className="settings-section">
            <label className="settings-label" htmlFor="hotkey-input">
              Global Hotkey
            </label>
            <div className="hotkey-row">
              <input
                id="hotkey-input"
                type="text"
                className="settings-input settings-input--hotkey"
                value={hotkey}
                readOnly
                onKeyDown={handleHotkeyKeyDown}
                onFocus={() => setCapturingHotkey(true)}
                onBlur={() => setCapturingHotkey(false)}
                placeholder={capturingHotkey ? 'Press a key combination…' : 'Click to capture…'}
              />
            </div>
            <p className="settings-hint">
              Click the field, then press a key combination (e.g. Ctrl+Shift+D). Saved via the Save
              button below.
            </p>
          </div>
        </>
      )
    }

    // providers category
    return (
      <>
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
      </>
    )
  }

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

      {/* ---- Category tabs ---- */}
      <div className="settings-categories">
        <button
          className={`settings-category-tab ${activeCategory === 'general' ? 'active' : ''}`}
          onClick={() => setActiveCategory('general')}
        >
          General
        </button>
        <button
          className={`settings-category-tab ${activeCategory === 'providers' ? 'active' : ''}`}
          onClick={() => setActiveCategory('providers')}
        >
          Providers
        </button>
      </div>

      {/* ---- Category content with animation ---- */}
      <div className="settings-content">{renderCategoryContent()}</div>

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
