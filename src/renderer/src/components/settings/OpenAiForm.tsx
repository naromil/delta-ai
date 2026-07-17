interface OpenAiFormProps {
  apiKey: string
  baseUrl: string
  customModel: string
  onApiKeyChange: (v: string) => void
  onBaseUrlChange: (v: string) => void
  onCustomModelChange: (v: string) => void
  onDirty: () => void
}

function OpenAiForm({
  apiKey,
  baseUrl,
  customModel,
  onApiKeyChange,
  onBaseUrlChange,
  onCustomModelChange,
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
    </div>
  )
}

export default OpenAiForm
