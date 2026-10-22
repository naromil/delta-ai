import { useCallback, useEffect, useRef, useState } from 'react'
import { providerRegistry, roleRegistry } from '../../../../../shared/models'
import { catalogModelsForType, describeCatalogModel } from '../../../../../shared/model-catalog'
import type { CatalogModel, ModelCatalogState } from '../../../../../shared/model-catalog'
import type {
  Connection,
  ModelConfig,
  RoleAssignment,
  RoleDef,
  RoleId
} from '../../../../../shared/models'
import type { PickerModel } from '../../../../../shared/model-picker'
import ModelPicker from './ModelPicker'

function formatModelHint(model: CatalogModel): string {
  const parts = [describeCatalogModel(model), model.toolCall ? '' : 'no tool support']
  return parts.filter((part) => part.length > 0).join(' · ')
}

interface RoleRowProps {
  roleDef: RoleDef
  roleId: RoleId
  assignment: RoleAssignment
  modelConfig: ModelConfig
  catalog: ModelCatalogState
  onConnectionChange: (roleId: RoleId, connectionId: string | null) => void
  onModelChange: (roleId: RoleId, model: string) => void
}

function RoleRow({
  roleDef,
  roleId,
  assignment,
  modelConfig,
  catalog,
  onConnectionChange,
  onModelChange
}: RoleRowProps): React.JSX.Element {
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)
  const [connectionOpen, setConnectionOpen] = useState(false)
  const autoFetchedRef = useRef(false)
  const currentModelRef = useRef(assignment.model)
  const connectionRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    currentModelRef.current = assignment.model
  }, [assignment.model])

  useEffect(() => {
    if (!connectionOpen) return
    const handleMouseDown = (event: MouseEvent): void => {
      if (!connectionRef.current?.contains(event.target as Node)) setConnectionOpen(false)
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [connectionOpen])

  const conn = assignment.connectionId ? modelConfig.connections[assignment.connectionId] : null
  const providerType = conn?.providerType
  const def = providerType ? providerRegistry[providerType] : undefined
  const catalogModels = catalogModelsForType(catalog.catalog, providerType)
  // The live catalog is authoritative; the bundled lists only cover offline use.
  const baseModelIds =
    catalogModels.length > 0 ? catalogModels.map((m) => m.id) : (def?.knownModels ?? [])
  // A successful discovery replaces the catalog for this row.
  const modelIds = fetchedModels ?? baseModelIds
  const selectedModel = catalogModels.find((m) => m.id === assignment.model)
  const isUnimplemented = providerType ? !def?.implemented : false
  const pickerModels: PickerModel[] = modelIds.map((id) => {
    const catalogModel = catalogModels.find((m) => m.id === id)
    return catalogModel ? { id, hint: formatModelHint(catalogModel) } : { id }
  })
  // Keep the current value selectable even when it is not in the list (custom
  // endpoint or offline fallback), without inventing metadata for it.
  if (assignment.model && !modelIds.includes(assignment.model)) {
    pickerModels.push({ id: assignment.model })
  }

  const applyFetchedModels = useCallback(
    (models: string[]): void => {
      setFetchedModels(models)
      setFetchError(null)
      if (models.length === 0) return
      const current = currentModelRef.current
      if (!models.includes(current)) onModelChange(roleId, models[0])
    },
    [onModelChange, roleId]
  )

  const handleFetch = useCallback(async (): Promise<void> => {
    if (!conn) return
    setFetching(true)
    try {
      const result = await window.api.listProviderModels(conn)
      if (result.error) {
        setFetchError(result.error)
        return
      }
      applyFetchedModels(result.models)
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err))
    } finally {
      setFetching(false)
    }
  }, [conn, applyFetchedModels])

  // Ollama's installed models are local and cheap to list; fetch them once so
  // the user does not have to type a tag from memory.
  useEffect(() => {
    if (autoFetchedRef.current || providerType !== 'ollama' || !conn || roleDef.locked) return
    autoFetchedRef.current = true
    void handleFetch()
  }, [providerType, conn, roleDef.locked, handleFetch])

  const handleModelChange = (model: string): void => {
    onModelChange(roleId, model)
  }

  const handleConnectionSelect = (connectionId: string | null): void => {
    onConnectionChange(roleId, connectionId)
    setConnectionOpen(false)
  }

  const renderModelField = (): React.JSX.Element => {
    if (!assignment.connectionId) {
      return (
        <ModelPicker
          models={[]}
          value={assignment.model}
          onChange={handleModelChange}
          disabled
          placeholder="Select a connection first"
        />
      )
    }
    return (
      <>
        <ModelPicker
          models={pickerModels}
          value={assignment.model}
          onChange={handleModelChange}
          placeholder={modelIds.length === 0 ? 'Enter model ID (e.g. gpt-4)' : 'Search models…'}
        />
        {selectedModel && (
          <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--text-muted)' }}>
            {formatModelHint(selectedModel)}
          </p>
        )}
      </>
    )
  }

  return (
    <div className="settings-card" style={{ opacity: roleDef.locked ? 0.5 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <strong style={{ fontSize: '15px' }}>{roleDef.label}</strong>
        {roleDef.locked && (
          <span
            title="Requires the Knowledge Base feature."
            style={{ fontSize: '13px', color: 'var(--text-muted)' }}
          >
            🔒 Locked
          </span>
        )}
        {isUnimplemented && (
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>(coming soon)</span>
        )}
      </div>
      <p style={{ margin: '0 0 10px', fontSize: '13px', color: 'var(--text-2)' }}>
        {roleDef.description}
      </p>

      {/* Connection selector */}
      <div style={{ marginBottom: '8px' }}>
        <label className="settings-label" style={{ marginBottom: '4px', fontSize: '13px' }}>
          Connection
        </label>
        <div className="settings-select-wrap" ref={connectionRef}>
          <button
            type="button"
            className="settings-select settings-select--button"
            aria-haspopup="menu"
            aria-expanded={connectionOpen}
            disabled={roleDef.locked}
            onClick={() => setConnectionOpen((open) => !open)}
          >
            {conn?.label ?? 'Not configured…'}
          </button>
          {connectionOpen && (
            <div
              className="settings-select-menu"
              role="menu"
              onKeyDown={(event) => {
                if (event.key === 'Escape') setConnectionOpen(false)
              }}
            >
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!assignment.connectionId}
                className={`settings-select-option${
                  !assignment.connectionId ? ' settings-select-option--active' : ''
                }`}
                onClick={() => handleConnectionSelect(null)}
              >
                Not configured…
              </button>
              {Object.values(modelConfig.connections).map((c: Connection) => (
                <button
                  key={c.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={c.id === assignment.connectionId}
                  className={`settings-select-option${
                    c.id === assignment.connectionId ? ' settings-select-option--active' : ''
                  }`}
                  onClick={() => handleConnectionSelect(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Model field */}
      <div style={{ marginBottom: '8px' }}>
        <label className="settings-label" style={{ marginBottom: '4px', fontSize: '13px' }}>
          Model
        </label>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>{renderModelField()}</div>
          <button
            type="button"
            className="settings-header-save"
            style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}
            onClick={handleFetch}
            disabled={!conn || roleDef.locked || fetching}
          >
            {fetching ? 'Fetching…' : 'Fetch'}
          </button>
        </div>
        {fetchError && (
          <p role="alert" style={{ margin: '4px 0 0', fontSize: '12px', color: '#e74c3c' }}>
            {fetchError}
          </p>
        )}
      </div>
    </div>
  )
}

// Re-export the ordered list of roles for the Models tab.
export const ROLE_DEFS_ORDERED: Array<{ id: RoleId; def: RoleDef }> = (
  Object.keys(roleRegistry) as RoleId[]
).map((id) => ({ id, def: roleRegistry[id] }))

export default RoleRow
