import { useState, useEffect, useRef } from 'react'
import HotkeyInput from '../../components/settings/HotkeyInput'
import GoogleAiForm from '../../components/settings/GoogleAiForm'
import OpenAiForm from '../../components/settings/OpenAiForm'

// ---- Types ----
type Category = 'general' | 'providers'

type ProviderConfig = {
  apiKey: string
  model: string
  baseUrl?: string
}

type AllProvidersConfig = {
  currentProvider: string
  providers: {
    'google-ai-studio'?: ProviderConfig
    'openai-compatible'?: ProviderConfig
  }
}

interface SettingsProps {
  onBack: () => void
}

function Settings({ onBack }: SettingsProps): React.JSX.Element {
  // ---- State declarations ----
  const [activeCategory, setActiveCategory] = useState<Category>('general')
  const [selectedProvider, setSelectedProvider] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('gemini-3.5-flash')
  const [customModel, setCustomModel] = useState('')
  const [isCustomModel, setIsCustomModel] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [hotkey, setHotkey] = useState('Ctrl+Shift+D')
  const hotkeyRef = useRef(hotkey)

  const cacheRef = useRef<AllProvidersConfig>({
    currentProvider: '',
    providers: {}
  })

  // ---- Return the correct model name for save ----
  const resolveModel = (provider: string): string => {
    if (provider === 'google-ai-studio' && !isCustomModel) return model
    return customModel.trim()
  }

  // ---- Cache Management ----
  const flushToCache = (): void => {
    const provider = selectedProvider
    if (!provider) return
    const finalModel = resolveModel(provider)
    const entry: ProviderConfig = {
      apiKey,
      model: finalModel,
      ...(provider === 'openai-compatible' && baseUrl ? { baseUrl } : {})
    }
    cacheRef.current.providers[provider as keyof typeof cacheRef.current.providers] = entry
  }

  const loadFromCache = (provider: string): void => {
    const providers = cacheRef.current.providers as Record<string, ProviderConfig | undefined>
    const entry = providers[provider]

    setApiKey('')
    setBaseUrl('')
    setModel('gemini-3.5-flash')
    setCustomModel('')
    setIsCustomModel(false)

    if (!entry) return
    if (entry.apiKey) setApiKey(entry.apiKey)
    if (entry.baseUrl) setBaseUrl(entry.baseUrl)
    if (entry.model) {
      if (provider === 'google-ai-studio') {
        const known = [
          'gemini-3.5-flash',
          'gemini-3.1-pro',
          'gemini-3.1-flash-lite',
          'gemini-2.5-flash',
          'gemma-4-31b-it'
        ]
        if (known.includes(entry.model)) {
          setModel(entry.model)
          setIsCustomModel(false)
        } else {
          setCustomModel(entry.model)
          setIsCustomModel(true)
        }
      } else {
        setCustomModel(entry.model)
        setIsCustomModel(true)
      }
    }
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    flushToCache()
    cacheRef.current.currentProvider = selectedProvider

    const allConfig = cacheRef.current
    const saveCfgProm = window.api.saveAllProviders(allConfig)
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

  // ---- Event handlers ----
  const switchProvider = (provider: string): void => {
    flushToCache()
    setSelectedProvider(provider)
    setSaved(false)
    loadFromCache(provider)
  }

  const handleHotkeyChange = (combo: string): void => {
    setHotkey(combo)
    hotkeyRef.current = combo
  }

  /* load existing config + settings on mount */
  useEffect(() => {
    window.api.loadAllProviders().then((allCfg) => {
      if (!allCfg || typeof allCfg !== 'object') return
      const all = allCfg as AllProvidersConfig
      cacheRef.current = {
        currentProvider: all.currentProvider ?? '',
        providers: all.providers ?? {}
      }

      if (cacheRef.current.currentProvider) {
        setSelectedProvider(cacheRef.current.currentProvider)
        loadFromCache(cacheRef.current.currentProvider)
      }
    })

    window.api.loadSettings().then((s) => {
      if (s?.hotkey) {
        setHotkey(s.hotkey)
        hotkeyRef.current = s.hotkey
      }
    })
  }, [])

  const canSave = selectedProvider !== ''

  // ---- Render a category on switch ----
  const renderCategoryContent = (): React.JSX.Element => {
    if (activeCategory === 'general') {
      return <HotkeyInput value={hotkey} onChange={handleHotkeyChange} />
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
            onChange={(e) => switchProvider(e.target.value)}
          >
            <option value="" disabled>
              Select a provider…
            </option>
            <option value="google-ai-studio">Google AI Studio</option>
            <option value="openai-compatible">OpenAI Compatible</option>
          </select>
        </div>

        {/* ---- Provider-specific fields ---- */}
        {selectedProvider === 'google-ai-studio' && (
          <GoogleAiForm
            apiKey={apiKey}
            model={model}
            customModel={customModel}
            isCustomModel={isCustomModel}
            onApiKeyChange={setApiKey}
            onModelChange={setModel}
            onCustomModelChange={setCustomModel}
            onIsCustomModelChange={setIsCustomModel}
            onDirty={() => setSaved(false)}
          />
        )}

        {selectedProvider === 'openai-compatible' && (
          <OpenAiForm
            apiKey={apiKey}
            baseUrl={baseUrl}
            customModel={customModel}
            onApiKeyChange={setApiKey}
            onBaseUrlChange={setBaseUrl}
            onCustomModelChange={setCustomModel}
            onDirty={() => setSaved(false)}
          />
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
