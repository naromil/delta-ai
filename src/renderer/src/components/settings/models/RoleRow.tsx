import { useState } from 'react'
import { providerRegistry, roleRegistry } from '../../../../../shared/models'
import type {
  Connection,
  ModelConfig,
  RoleAssignment,
  RoleDef,
  RoleId
} from '../../../../../shared/models'

interface RoleRowProps {
  roleDef: RoleDef
  roleId: RoleId
  assignment: RoleAssignment
  modelConfig: ModelConfig
  onConnectionChange: (roleId: RoleId, connectionId: string | null) => void
  onModelChange: (roleId: RoleId, model: string) => void
  onWebSearchChange: (roleId: RoleId, checked: boolean) => void
}

function RoleRow({
  roleDef,
  roleId,
  assignment,
  modelConfig,
  onConnectionChange,
  onModelChange,
  onWebSearchChange
}: RoleRowProps): React.JSX.Element {
  const conn = assignment.connectionId ? modelConfig.connections[assignment.connectionId] : null
  const providerType = conn?.providerType
  const def = providerType ? providerRegistry[providerType] : undefined
  const knownModels = def?.knownModels
  const isUnimplemented = providerType ? !def?.implemented : false

  // Role-local tracking of whether the custom-model input is being shown.
  // Re-initialized from the assignment when the parent remounts the row on
  // connection change (see key in ModelsTab).
  const [isCustom, setIsCustom] = useState<boolean>(() => {
    if (!knownModels || !assignment.model) return false
    return !knownModels.includes(assignment.model)
  })
  const [customModel, setCustomModel] = useState<string>(
    knownModels?.includes(assignment.model) ? '' : assignment.model
  )

  const handleModelSelect = (value: string): void => {
    if (value === 'Custom...') {
      setIsCustom(true)
      if (!customModel) onModelChange(roleId, '')
    } else {
      setIsCustom(false)
      onModelChange(roleId, value)
    }
  }

  const renderModelField = (): React.JSX.Element => {
    if (!assignment.connectionId) {
      return (
        <input
          type="text"
          className="settings-input"
          value=""
          disabled
          placeholder="Select a connection first"
        />
      )
    }
    if (!knownModels || knownModels.length === 0) {
      return (
        <input
          type="text"
          className="settings-input"
          spellCheck="false"
          value={assignment.model}
          onChange={(e) => onModelChange(roleId, e.target.value)}
          placeholder="Enter model ID (e.g. gpt-4)"
        />
      )
    }
    return (
      <>
        <select
          className="settings-select"
          value={isCustom ? 'Custom...' : assignment.model}
          onChange={(e) => handleModelSelect(e.target.value)}
        >
          {knownModels.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value="Custom...">Custom…</option>
        </select>
        {isCustom && (
          <input
            type="text"
            className="settings-input settings-input--custom"
            spellCheck="false"
            value={customModel}
            onChange={(e) => {
              setCustomModel(e.target.value)
              onModelChange(roleId, e.target.value)
            }}
            placeholder="Enter custom model name…"
          />
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
        <select
          className="settings-select"
          value={assignment.connectionId ?? ''}
          disabled={roleDef.locked}
          onChange={(e) => onConnectionChange(roleId, e.target.value || null)}
        >
          <option value="">Not configured…</option>
          {Object.values(modelConfig.connections).map((c: Connection) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      {/* Model field */}
      <div style={{ marginBottom: '8px' }}>
        <label className="settings-label" style={{ marginBottom: '4px', fontSize: '13px' }}>
          Model
        </label>
        {renderModelField()}
      </div>

      {/* Web search toggle */}
      {roleDef.offersWebSearch && (
        <label className="toggle-row" style={{ marginTop: '8px' }}>
          <input
            type="checkbox"
            className="toggle-input"
            checked={assignment.webSearchEnabled}
            disabled={roleDef.locked || !assignment.connectionId}
            onChange={(e) => onWebSearchChange(roleId, e.target.checked)}
          />
          <span className="toggle-track">
            <span className="toggle-thumb" />
          </span>
          <span className="toggle-label">
            {assignment.webSearchEnabled ? 'Web search enabled' : 'Web search disabled'}
          </span>
        </label>
      )}
    </div>
  )
}

// Re-export the ordered list of roles for the Models tab.
export const ROLE_DEFS_ORDERED: Array<{ id: RoleId; def: RoleDef }> = (
  Object.keys(roleRegistry) as RoleId[]
).map((id) => ({ id, def: roleRegistry[id] }))

export default RoleRow
