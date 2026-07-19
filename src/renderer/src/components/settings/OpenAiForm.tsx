interface OpenAiFormProps {
  apiKey: string
  baseUrl: string
  customModel: string
  webSearchEnabled: boolean
  onApiKeyChange: (v: string) => void
  onBaseUrlChange: (v: string) => void
  onCustomModelChange: (v: string) => void
  onWebSearchChange: (v: boolean) => void
  onDirty: () => void
}

function OpenAiForm({
  apiKey,
  baseUrl,
  customModel,
  webSearchEnabled,
  onApiKeyChange,
  onBaseUrlChange,
  onCustomModelChange,
  onWebSearchChange,
  onDirty
}: OpenAiFormProps): React.JSX.Element {
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
        placeholder="Enter your API key…"
      />

      <label className="settings-label" htmlFor="base-url-input">
        Base URL
      </label>
      <input
        id="base-url-input"
        type="text"
        className="settings-input"
        spellCheck="false"
        value={baseUrl}
        onChange={(e) => {
          onBaseUrlChange(e.target.value)
          onDirty()
        }}
        placeholder="https://api.example.com/v1"
      />

      <label className="settings-label" htmlFor="model-input">
        Model
      </label>
      <input
        id="model-input"
        type="text"
        className="settings-input"
        spellCheck="false"
        value={customModel}
        onChange={(e) => {
          onCustomModelChange(e.target.value)
          onDirty()
        }}
        placeholder="Enter model ID (e.g. gpt-4)"
      />

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
        <span className="toggle-label">{webSearchEnabled ? 'Enabled' : 'Disabled'}</span>
      </label>
      <p className="settings-warning">
        Web search is a provider-specific extension. Many OpenAI-compatible endpoints do not support
        it. Check your provider&apos;s documentation before enabling.
      </p>
    </div>
  )
}

export default OpenAiForm
