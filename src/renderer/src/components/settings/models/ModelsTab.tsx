import { useState } from 'react'
import { generateConnectionId, providerRegistry } from '../../../../../shared/models'
import type {
  Connection,
  ModelConfig,
  ProviderType,
  RoleAssignment,
  RoleId
} from '../../../../../shared/models'
import { catalogModelsForType } from '../../../../../shared/model-catalog'
import type { ModelCatalogState } from '../../../../../shared/model-catalog'
import RoleRow, { ROLE_DEFS_ORDERED } from './RoleRow'
import ConnectionCard from './ConnectionCard'

interface ModelsTabProps {
  modelConfig: ModelConfig
  catalog: ModelCatalogState
  catalogLoading: boolean
  onRefreshCatalog: () => void
  onUpdateRole: (roleId: RoleId, updates: Partial<RoleAssignment>) => void
  onUpdateConnection: (connId: string, updates: Partial<Connection>) => void
  onAddConnection: (connection: Connection) => void
  onDeleteConnection: (connId: string) => void
}

function describeCatalogStatus(catalog: ModelCatalogState): string {
  if (!catalog.catalog) {
    return catalog.error ? `Model list unavailable — ${catalog.error}` : 'Model list unavailable'
  }
  const total = Object.values(catalog.catalog.providers).reduce(
    (count, models) => count + (models?.length ?? 0),
    0
  )
  const updated = new Date(catalog.catalog.fetchedAt).toLocaleDateString()
  const offline = catalog.error ? ' · showing cached copy' : ''
  return `${total} models from models.dev · updated ${updated}${offline}`
}

/**
 * Model to probe with: an assigned role model for this connection, then the catalog,
 * then the bundled list.
 */
function probeModelFor(
  conn: Connection,
  modelConfig: ModelConfig,
  catalog: ModelCatalogState
): string | undefined {
  for (const { id } of ROLE_DEFS_ORDERED) {
    const assignment = modelConfig.roles[id]
    if (assignment.connectionId === conn.id && assignment.model) return assignment.model
  }
  return (
    catalogModelsForType(catalog.catalog, conn.providerType)[0]?.id ??
    providerRegistry[conn.providerType].knownModels?.[0]
  )
}

function ModelsTab({
  modelConfig,
  catalog,
  catalogLoading,
  onRefreshCatalog,
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
      {/* ---- Catalog status ---- */}
      <div className="settings-section">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <p style={{ margin: 0, flex: 1, fontSize: '12px', color: 'var(--text-muted)' }}>
            {describeCatalogStatus(catalog)}
          </p>
          <button
            className="settings-header-save"
            onClick={onRefreshCatalog}
            disabled={catalogLoading}
          >
            {catalogLoading ? 'Refreshing…' : 'Refresh models'}
          </button>
        </div>
      </div>

      {/* ---- Roles Section ---- */}
      <div className="settings-section">
        <h3 className="settings-section-title">Roles</h3>
        {ROLE_DEFS_ORDERED.map(({ id, def }) => (
          <RoleRow
            key={`${id}-${modelConfig.roles[id].connectionId ?? 'none'}-${catalog.catalog?.fetchedAt ?? 'offline'}`}
            roleId={id}
            roleDef={def}
            assignment={modelConfig.roles[id]}
            modelConfig={modelConfig}
            catalog={catalog}
            onConnectionChange={(roleId, connectionId) => {
              const conn = connectionId ? modelConfig.connections[connectionId] : null
              const connDef = conn ? providerRegistry[conn.providerType] : undefined
              const defaultModel =
                catalogModelsForType(catalog.catalog, conn?.providerType)[0]?.id ??
                connDef?.knownModels?.[0] ??
                ''
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
            probeModel={probeModelFor(conn, modelConfig, catalog)}
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
