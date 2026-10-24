import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Connection,
  LookupContextMode,
  ModelConfig,
  RoleAssignment,
  RoleId
} from '../../../../shared/models'
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

type SettingsTab = 'general' | 'models' | 'about'

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'models', label: 'Models' },
  { id: 'about', label: 'About' }
]

function Settings(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const [modelConfig, setModelConfig] = useState<ModelConfig>(createDefaultModelConfig)
  const [catalog, setCatalog] = useState<ModelCatalogState>({
    catalog: null,
    source: 'unavailable'
  })
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [hotkey, setHotkey] = useState('Ctrl+Shift+D')
  const [hotkeyMode, setHotkeyMode] = useState<'global' | 'local'>('global')
  const [closeToTray, setCloseToTray] = useState(true)
  const [lookupContextMode, setLookupContextMode] = useState<LookupContextMode>('clipboard')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
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

    window.api.getHotkeyStatus().then((status) => setHotkeyMode(status.mode))

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
      if (
        settings?.lookupContextMode === 'clipboard' ||
        settings?.lookupContextMode === 'fullscreen-ocr'
      ) {
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
    setSaveError(null)
    try {
      const cfgRes = await window.api.saveModelConfig(modelConfig)
      const settingsRes = await window.api.saveSettings({
        hotkey: hotkeyRef.current,
        closeToTray,
        lookupContextMode: lookupContextModeRef.current
      })
      if (cfgRes.success && settingsRes.success) {
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
        setHotkeyMode(settingsRes.hotkeyMode)
      } else {
        setSaveError(cfgRes.error ?? settingsRes.error ?? 'Failed to save configuration.')
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save configuration.')
    } finally {
      setSaving(false)
    }
  }

  /* ---- Main render ---- */
  return (
    <div className="settings">
      <div className="settings-header">
        <div>
          <h2 className="settings-title">Settings</h2>
          <p className="settings-subtitle">Connections, model roles and look-up behaviour.</p>
        </div>
        <button className="btn btn--primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : saved ? 'Saved' : 'Save changes'}
        </button>
      </div>

      {saveError && (
        <p className="settings-error" role="alert">
          {saveError}
        </p>
      )}

      {/* ---- Tabs ---- */}
      <div className="settings-categories" role="tablist" aria-label="Settings sections">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`settings-category-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ---- Tab content ---- */}
      <div className="settings-content" role="tabpanel" id={`settings-panel-${activeTab}`}>
        {activeTab === 'general' && (
          <GeneralTab
            hotkey={hotkey}
            onHotkeyChange={(combo) => {
              setHotkey(combo)
              hotkeyRef.current = combo
            }}
            hotkeyMode={hotkeyMode}
            closeToTray={closeToTray}
            onCloseToTrayChange={setCloseToTray}
            lookupContextMode={lookupContextMode}
            onLookupContextModeChange={(mode) => {
              setLookupContextMode(mode)
              lookupContextModeRef.current = mode
            }}
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
            <h3 className="settings-section-title">Delta AI</h3>
            <p className="settings-about-text">
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
