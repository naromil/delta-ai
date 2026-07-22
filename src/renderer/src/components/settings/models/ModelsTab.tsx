import { useState } from 'react'
import { generateConnectionId, providerRegistry } from '../../../../../shared/models'
import type {
  Connection,
  ModelConfig,
  ProviderType,
  RoleAssignment,
  RoleId
} from '../../../../../shared/models'
import RoleRow, { ROLE_DEFS_ORDERED } from './RoleRow'
import ConnectionCard from './ConnectionCard'

interface ModelsTabProps {
  modelConfig: ModelConfig
  onUpdateRole: (roleId: RoleId, updates: Partial<RoleAssignment>) => void
  onUpdateConnection: (connId: string, updates: Partial<Connection>) => void
  onAddConnection: (connection: Connection) => void
  onDeleteConnection: (connId: string) => void
}

function ModelsTab({
  modelConfig,
  onUpdateRole,
  onUpdateConnection,
  onAddConnection,
  onDeleteConnection
}: ModelsTabProps): React.JSX.Element {
  const [addProviderType, setAddProviderType] = useState<ProviderType>('google-ai-studio')

  const handleAdd = (): void => {
    const def = providerRegistry[addProviderType]
    const conn: Connection = {
      id: generateConnectionId(),
      label: def.label,
      providerType: addProviderType,
      apiKey: ''
    }
    if (def.defaultBaseUrl) conn.baseUrl = def.defaultBaseUrl
    if (addProviderType === 'ollama') conn.host = 'http://localhost:11434'
    onAddConnection(conn)
  }

  return (
    <>
      {/* ---- Roles Section ---- */}
      <div className="settings-section">
        <h3 className="settings-section-title">Roles</h3>
        {ROLE_DEFS_ORDERED.map(({ id, def }) => (
          <RoleRow
            key={`${id}-${modelConfig.roles[id].connectionId ?? 'none'}`}
            roleId={id}
            roleDef={def}
            assignment={modelConfig.roles[id]}
            modelConfig={modelConfig}
            onConnectionChange={(roleId, connectionId) => {
              const conn = connectionId ? modelConfig.connections[connectionId] : null
              const connDef = conn ? providerRegistry[conn.providerType] : undefined
              const defaultModel =
                connDef?.knownModels && connDef.knownModels.length > 0 ? connDef.knownModels[0] : ''
              onUpdateRole(roleId, { connectionId, model: defaultModel })
            }}
            onModelChange={(roleId, model) => onUpdateRole(roleId, { model })}
            onWebSearchChange={(roleId, checked) =>
              onUpdateRole(roleId, { webSearchEnabled: checked })
            }
          />
        ))}
      </div>

      {/* ---- Connections Section ---- */}
      <div className="settings-section">
        <h3 className="settings-section-title">Connections</h3>

        {Object.values(modelConfig.connections).length === 0 && (
          <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
            No connections yet. Add one below.
          </p>
        )}

        {Object.values(modelConfig.connections).map((conn) => (
          <ConnectionCard
            key={conn.id}
            connection={conn}
            onUpdate={onUpdateConnection}
            onDelete={onDeleteConnection}
          />
        ))}

        {/* Add connection */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' }}>
          <select
            className="settings-select"
            style={{ width: 'auto', flex: 1 }}
            value={addProviderType}
            onChange={(e) => setAddProviderType(e.target.value as ProviderType)}
          >
            {(Object.keys(providerRegistry) as ProviderType[]).map((pt) => (
              <option key={pt} value={pt}>
                {providerRegistry[pt].label}
              </option>
            ))}
          </select>
          <button className="settings-header-save" onClick={handleAdd}>
            Add Connection
          </button>
        </div>
      </div>
    </>
  )
}

export default ModelsTab
