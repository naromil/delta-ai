const GOOGLE_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.1-pro',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemma-4-31b-it',
  'Custom...'
] as const

interface GoogleAiFormProps {
  apiKey: string
  model: string
  customModel: string
  isCustomModel: boolean
  webSearchEnabled: boolean
  onApiKeyChange: (v: string) => void
  onModelChange: (v: string) => void
  onCustomModelChange: (v: string) => void
  onIsCustomModelChange: (v: boolean) => void
  onWebSearchChange: (v: boolean) => void
  onDirty: () => void
}

function GoogleAiForm({
  apiKey,
  model,
  customModel,
  isCustomModel,
  webSearchEnabled,
  onApiKeyChange,
  onModelChange,
  onCustomModelChange,
  onIsCustomModelChange,
  onWebSearchChange,
  onDirty
}: GoogleAiFormProps): React.JSX.Element {
  return (
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
          onApiKeyChange(e.target.value)
          onDirty()
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
            onIsCustomModelChange(true)
          } else {
            onModelChange(e.target.value)
            onIsCustomModelChange(false)
          }
          onDirty()
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
          spellCheck="false"
          value={customModel}
          onChange={(e) => {
            onCustomModelChange(e.target.value)
            onDirty()
          }}
          placeholder="Enter custom model name…"
        />
      )}

      <label className="settings-label">Web Search</label>
      <label className="toggle-row">
        <input
          type="checkbox"
          className="toggle-input"
          checked={webSearchEnabled}
          onChange={(e) => {
            onWebSearchChange(e.target.checked)
            onDirty()
          }}
        />
        <span className="toggle-track">
          <span className="toggle-thumb" />
        </span>
        <span className="toggle-label">
          {webSearchEnabled ? 'Uses Google Search grounding via Gemini API' : 'Disabled'}
        </span>
      </label>
    </div>
  )
}

export default GoogleAiForm
