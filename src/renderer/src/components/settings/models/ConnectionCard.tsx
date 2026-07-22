import { providerRegistry } from '../../../../../shared/models'
import type { Connection, ProviderType } from '../../../../../shared/models'

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

  const handleProviderTypeChange = (providerType: ProviderType): void => {
    const newDef = providerRegistry[providerType]
    const updates: Partial<Connection> = {
      providerType,
      baseUrl: newDef.defaultBaseUrl ?? undefined,
      host: providerType === 'ollama' ? 'http://localhost:11434' : undefined
    }
    if (newDef.authShape !== 'apiKey') updates.apiKey = ''
    if (newDef.authShape !== 'host') updates.host = ''
    onUpdate(connection.id, updates)
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
          onChange={(e) => onUpdate(connection.id, { label: e.target.value })}
          placeholder="Connection name"
        />
        <button
          className="settings-header-save"
          style={{ background: '#e74c3c22', color: '#e74c3c', padding: '4px 12px' }}
          onClick={() => onDelete(connection.id)}
        >
          Delete
        </button>
      </div>

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
            onChange={(e) => onUpdate(connection.id, { apiKey: e.target.value })}
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
            onChange={(e) => onUpdate(connection.id, { host: e.target.value })}
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
            onChange={(e) => onUpdate(connection.id, { baseUrl: e.target.value })}
            placeholder="https://api.openai.com/v1"
          />
        </div>
      )}
    </div>
  )
}

export default ConnectionCard
