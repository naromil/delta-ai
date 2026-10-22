import { useCallback, useEffect, useRef, useState } from 'react'
import type { Connection, ModelConfig, RoleAssignment, RoleId } from '../../../../shared/models'
import { createDefaultModelConfig } from '../../../../shared/models'
import type { ModelCatalogState } from '../../../../shared/model-catalog'
import GeneralTab from './GeneralTab'
import ModelsTab from '../../components/settings/models/ModelsTab'

function catalogErrorState(err: unknown): ModelCatalogState {
  return {
    catalog: null,
    source: 'unavailable',
    error: err instanceof Error ? err.message : String(err)
  }
}

/* ---- Component ---- */

function Settings(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<'general' | 'models' | 'about'>('general')
  const [modelConfig, setModelConfig] = useState<ModelConfig>(createDefaultModelConfig)
  const [catalog, setCatalog] = useState<ModelCatalogState>({
    catalog: null,
    source: 'unavailable'
  })
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [hotkey, setHotkey] = useState('Ctrl+Shift+D')
  const [closeToTray, setCloseToTray] = useState(true)
  const [lookupContextMode, setLookupContextMode] = useState('clipboard')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const hotkeyRef = useRef(hotkey)
  const lookupContextModeRef = useRef(lookupContextMode)

  const refreshCatalog = useCallback((): void => {
    setCatalogLoading(true)
    window.api
      .loadModelCatalog(true)
      .then(setCatalog)
      .catch((err: unknown) => setCatalog(catalogErrorState(err)))
      .finally(() => setCatalogLoading(false))
  }, [])

  /* Load existing config on mount */
  useEffect(() => {
    window.api.loadModelConfig().then((cfg) => {
      if (cfg && typeof cfg === 'object') {
        setModelConfig(cfg as ModelConfig)
      }
    })

    window.api
      .loadModelCatalog(false)
      .then(setCatalog)
      .catch((err: unknown) => setCatalog(catalogErrorState(err)))

    window.api.loadSettings().then((s) => {
      const settings = s as {
        hotkey?: string
        closeToTray?: boolean
        lookupContextMode?: string
      } | null
      if (settings?.hotkey) {
        setHotkey(settings.hotkey)
        hotkeyRef.current = settings.hotkey
      }
      if (settings?.closeToTray !== undefined) {
        setCloseToTray(settings.closeToTray)
      }
      if (settings?.lookupContextMode) {
        setLookupContextMode(settings.lookupContextMode)
        lookupContextModeRef.current = settings.lookupContextMode
      }
    })
  }, [])

  /* ---- Mutation helpers ---- */

  const updateRole = (roleId: RoleId, updates: Partial<RoleAssignment>): void => {
    setModelConfig((prev) => ({
      ...prev,
      roles: { ...prev.roles, [roleId]: { ...prev.roles[roleId], ...updates } }
    }))
  }

  const updateConnection = (connId: string, updates: Partial<Connection>): void => {
    setModelConfig((prev) => ({
      ...prev,
      connections: {
        ...prev.connections,
        [connId]: { ...prev.connections[connId], ...updates }
      }
    }))
  }

  const addConnection = (connection: Connection): void => {
    setModelConfig((prev) => ({
      ...prev,
      connections: { ...prev.connections, [connection.id]: connection }
    }))
  }

  const deleteConnection = (connId: string): void => {
    setModelConfig((prev) => {
      const next = { ...prev, connections: { ...prev.connections } }
      delete next.connections[connId]
      const roles = { ...next.roles } as Record<RoleId, RoleAssignment>
      for (const key of Object.keys(roles) as RoleId[]) {
        if (roles[key].connectionId === connId) {
          roles[key] = { connectionId: null, model: '' }
        }
      }
      next.roles = roles
      return next
    })
  }

  /* ---- Save ---- */

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    const cfgRes = await window.api.saveModelConfig(modelConfig)
    const settingsRes = await window.api.saveSettings({
      hotkey: hotkeyRef.current,
      closeToTray,
      lookupContextMode: lookupContextModeRef.current
    })
    setSaving(false)
    if (cfgRes.success && settingsRes.success) {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } else {
      alert(cfgRes.error ?? 'Failed to save configuration.')
    }
  }

  /* ---- Main render ---- */
  return (
    <div className="settings">
      <div className="settings-header">
        <h2 className="settings-title">Settings</h2>
        <button className="settings-header-save" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save'}
        </button>
      </div>

      {/* ---- Tabs ---- */}
      <div className="settings-categories">
        <button
          className={`settings-category-tab ${activeTab === 'general' ? 'active' : ''}`}
          onClick={() => setActiveTab('general')}
        >
          General
        </button>
        <button
          className={`settings-category-tab ${activeTab === 'models' ? 'active' : ''}`}
          onClick={() => setActiveTab('models')}
        >
          Models
        </button>
        <button
          className={`settings-category-tab ${activeTab === 'about' ? 'active' : ''}`}
          onClick={() => setActiveTab('about')}
        >
          About
        </button>
      </div>

      {/* ---- Tab content ---- */}
      <div className="settings-content">
        {activeTab === 'general' && (
          <GeneralTab
            hotkey={hotkey}
            onHotkeyChange={(combo) => {
              setHotkey(combo)
              hotkeyRef.current = combo
            }}
            closeToTray={closeToTray}
            onCloseToTrayChange={setCloseToTray}
          />
        )}
        {activeTab === 'models' && (
          <ModelsTab
            modelConfig={modelConfig}
            catalog={catalog}
            catalogLoading={catalogLoading}
            onRefreshCatalog={refreshCatalog}
            onUpdateRole={updateRole}
            onUpdateConnection={updateConnection}
            onAddConnection={addConnection}
            onDeleteConnection={deleteConnection}
          />
        )}
        {activeTab === 'about' && (
          <div className="settings-section">
            <h3 style={{ margin: '0 0 8px', fontSize: '16px' }}>Delta AI</h3>
            <p style={{ color: 'var(--text-2)', fontSize: '14px', lineHeight: 1.6 }}>
              An AI-powered desktop assistant that captures your screen, runs OCR, and provides
              context-aware answers via the model of your choice.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

export default Settings
