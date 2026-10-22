import { useState } from 'react'
import { providerRegistry } from '../../../../../shared/models'
import type { Connection, ProviderType } from '../../../../../shared/models'

type TestOutcome = { ok: boolean; detail: string }

interface ConnectionCardProps {
  connection: Connection
  onUpdate: (connId: string, updates: Partial<Connection>) => void
  onDelete: (connId: string) => void
}

function ConnectionCard({
  connection,
  onUpdate,
  onDelete
}: ConnectionCardProps): React.JSX.Element {
  const def = providerRegistry[connection.providerType]
  const [testing, setTesting] = useState(false)
  const [testOutcome, setTestOutcome] = useState<TestOutcome | null>(null)

  // A previous result must not outlive a change to the fields it measured.
  const updateConnection = (updates: Partial<Connection>): void => {
    setTestOutcome(null)
    onUpdate(connection.id, updates)
  }

  const handleTest = async (): Promise<void> => {
    setTesting(true)
    try {
      const result = await window.api.testProviderConnection(connection, def.knownModels?.[0])
      setTestOutcome(result)
    } catch (err) {
      setTestOutcome({ ok: false, detail: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  const handleProviderTypeChange = (providerType: ProviderType): void => {
    const newDef = providerRegistry[providerType]
    const updates: Partial<Connection> = {
      providerType,
      baseUrl: newDef.defaultBaseUrl ?? undefined,
      host: providerType === 'ollama' ? 'http://localhost:11434' : undefined
    }
    if (newDef.authShape !== 'apiKey') updates.apiKey = ''
    if (newDef.authShape !== 'host') updates.host = ''
    updateConnection(updates)
  }

  return (
    <div className="settings-card">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '10px'
        }}
      >
        <input
          type="text"
          className="settings-input"
          style={{ width: '60%', fontWeight: 600 }}
          value={connection.label}
          onChange={(e) => updateConnection({ label: e.target.value })}
          placeholder="Connection name"
        />
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            className="settings-header-save"
            style={{ padding: '4px 12px' }}
            onClick={handleTest}
            disabled={testing}
          >
            {testing ? 'Testing…' : 'Test'}
          </button>
          <button
            className="settings-header-save"
            style={{ background: '#e74c3c22', color: '#e74c3c', padding: '4px 12px' }}
            onClick={() => onDelete(connection.id)}
          >
            Delete
          </button>
        </div>
      </div>

      {testOutcome && (
        <p
          role="status"
          style={{
            margin: '0 0 10px',
            fontSize: '12px',
            color: testOutcome.ok ? '#2ecc71' : '#e74c3c'
          }}
        >
          {testOutcome.ok ? '✓' : '✗'} {testOutcome.detail}
        </p>
      )}

      {/* Provider type */}
      <div style={{ marginBottom: '8px' }}>
        <label className="settings-label" style={{ marginBottom: '4px', fontSize: '13px' }}>
          Provider
        </label>
        <select
          className="settings-select"
          value={connection.providerType}
          onChange={(e) => handleProviderTypeChange(e.target.value as ProviderType)}
        >
          {(Object.keys(providerRegistry) as ProviderType[]).map((pt) => (
            <option key={pt} value={pt}>
              {providerRegistry[pt].label}
            </option>
          ))}
        </select>
      </div>

      {/* Auth-specific fields */}
      {def.authShape === 'apiKey' && (
        <div style={{ marginBottom: '8px' }}>
          <label className="settings-label" style={{ marginBottom: '4px', fontSize: '13px' }}>
            API Key
          </label>
          <input
            type="password"
            className="settings-input"
            value={connection.apiKey ?? ''}
            onChange={(e) => updateConnection({ apiKey: e.target.value })}
            placeholder="Enter your API key…"
          />
        </div>
      )}

      {def.authShape === 'host' && (
        <div style={{ marginBottom: '8px' }}>
          <label className="settings-label" style={{ marginBottom: '4px', fontSize: '13px' }}>
            Host
          </label>
          <input
            type="text"
            className="settings-input"
            spellCheck="false"
            value={connection.host ?? ''}
            onChange={(e) => updateConnection({ host: e.target.value })}
            placeholder="http://localhost:11434"
          />
        </div>
      )}

      {/* Base URL (host-based providers like Ollama use the host field) */}
      {connection.providerType !== 'ollama' && (
        <div style={{ marginBottom: '8px' }}>
          <label className="settings-label" style={{ marginBottom: '4px', fontSize: '13px' }}>
            Base URL
          </label>
          <input
            type="text"
            className="settings-input"
            spellCheck="false"
            value={connection.baseUrl ?? ''}
            onChange={(e) => updateConnection({ baseUrl: e.target.value })}
            placeholder="https://api.openai.com/v1"
          />
        </div>
      )}
    </div>
  )
}

export default ConnectionCard
