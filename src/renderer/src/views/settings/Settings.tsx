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
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'models', label: 'Models' },
  { id: 'about', label: 'About' }
]

const SAVE_STATUS_TEXT: Record<SaveStatus, string> = {
  idle: '',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Not saved'
}

/* Settings (the small file) serialized once, so autosave can tell a real edit from a re-render. */
function settingsSnapshot(
  hotkey: string,
  closeToTray: boolean,
  lookupContextMode: LookupContextMode,
  kbAutoMaintain: boolean
): string {
  return JSON.stringify({ hotkey, closeToTray, lookupContextMode, kbAutoMaintain })
}

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
  const [kbAutoMaintain, setKbAutoMaintain] = useState(true)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const savedConfigRef = useRef<string | null>(null)
  const savedSettingsRef = useRef<string | null>(null)
  const latestRef = useRef({
    modelConfig,
    hotkey,
    closeToTray,
    lookupContextMode,
    kbAutoMaintain
  })
  const hydratedRef = useRef(false)

  const refreshCatalog = useCallback((): void => {
    setCatalogLoading(true)
    window.api
      .loadModelCatalog(true)
      .then(setCatalog)
      .catch((err: unknown) => setCatalog(catalogErrorState(err)))
      .finally(() => setCatalogLoading(false))
  }, [])

  /* Load existing config, then hand control to autosave. */
  useEffect(() => {
    let cancelled = false

    void (async () => {
      const [cfg, raw] = await Promise.all([
        window.api.loadModelConfig(),
        window.api.loadSettings()
      ])
      if (cancelled) return

      const settings = raw as {
        hotkey?: string
        closeToTray?: boolean
        lookupContextMode?: string
        kbAutoMaintain?: boolean
      } | null
      const config = (
        cfg && typeof cfg === 'object' ? cfg : createDefaultModelConfig()
      ) as ModelConfig
      const nextHotkey = settings?.hotkey || 'Ctrl+Shift+D'
      const nextTray = settings?.closeToTray ?? true
      const nextMode: LookupContextMode =
        settings?.lookupContextMode === 'fullscreen-ocr' ? 'fullscreen-ocr' : 'clipboard'
      const nextKbAutoMaintain = settings?.kbAutoMaintain ?? true

      // Seed both baselines before flipping `hydrated`, so loading never writes back.
      savedConfigRef.current = JSON.stringify(config)
      savedSettingsRef.current = settingsSnapshot(
        nextHotkey,
        nextTray,
        nextMode,
        nextKbAutoMaintain
      )
      setModelConfig(config)
      setHotkey(nextHotkey)
      setCloseToTray(nextTray)
      setLookupContextMode(nextMode)
      setKbAutoMaintain(nextKbAutoMaintain)
      hydratedRef.current = true
      setHydrated(true)
    })()

    window.api
      .loadModelCatalog(false)
      .then(setCatalog)
      .catch((err: unknown) => setCatalog(catalogErrorState(err)))

    window.api.getHotkeyStatus().then((status) => {
      if (!cancelled) setHotkeyMode(status.mode)
    })

    return () => {
      cancelled = true
    }
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

  /* ---- Autosave ----
   * Both files are written from here, each only when its own half changed, so a look-up
   * preference never rewrites providers.json and vice versa. */

  const persist = useCallback(
    async (
      config: ModelConfig,
      nextHotkey: string,
      nextTray: boolean,
      nextMode: LookupContextMode,
      nextKbAutoMaintain: boolean
    ): Promise<void> => {
      setSaveStatus('saving')
      setSaveError(null)
      try {
        const configJson = JSON.stringify(config)
        if (configJson !== savedConfigRef.current) {
          const cfgRes = await window.api.saveModelConfig(config)
          if (!cfgRes.success) {
            setSaveStatus('error')
            setSaveError(cfgRes.error ?? 'Could not save the model configuration.')
            return
          }
          savedConfigRef.current = configJson
        }

        const settingsJson = settingsSnapshot(nextHotkey, nextTray, nextMode, nextKbAutoMaintain)
        if (settingsJson !== savedSettingsRef.current) {
          const settingsRes = await window.api.saveSettings({
            hotkey: nextHotkey,
            closeToTray: nextTray,
            lookupContextMode: nextMode,
            kbAutoMaintain: nextKbAutoMaintain
          })
          if (!settingsRes.success) {
            setSaveStatus('error')
            setSaveError(settingsRes.error ?? 'Could not save settings.')
            return
          }
          savedSettingsRef.current = settingsJson
          setHotkeyMode(settingsRes.hotkeyMode)
        }

        setSaveStatus('saved')
      } catch (err) {
        setSaveStatus('error')
        setSaveError(err instanceof Error ? err.message : 'Could not save settings.')
      }
    },
    []
  )

  const isDirty = useCallback(
    (
      config: ModelConfig,
      nextHotkey: string,
      nextTray: boolean,
      nextMode: LookupContextMode,
      nextKbAutoMaintain: boolean
    ): boolean =>
      JSON.stringify(config) !== savedConfigRef.current ||
      settingsSnapshot(nextHotkey, nextTray, nextMode, nextKbAutoMaintain) !==
        savedSettingsRef.current,
    []
  )

  useEffect(() => {
    latestRef.current = { modelConfig, hotkey, closeToTray, lookupContextMode, kbAutoMaintain }
  }, [modelConfig, hotkey, closeToTray, lookupContextMode, kbAutoMaintain])

  /* Debounced: typing an API key or a base URL must not hit the disk per keystroke. */
  useEffect(() => {
    if (!hydrated) return
    if (!isDirty(modelConfig, hotkey, closeToTray, lookupContextMode, kbAutoMaintain)) return
    const timer = window.setTimeout(() => {
      void persist(modelConfig, hotkey, closeToTray, lookupContextMode, kbAutoMaintain)
    }, 500)
    return () => window.clearTimeout(timer)
  }, [
    hydrated,
    modelConfig,
    hotkey,
    closeToTray,
    lookupContextMode,
    kbAutoMaintain,
    isDirty,
    persist
  ])

  /* Flush a pending edit if the view unmounts before the debounce fires. */
  useEffect(() => {
    return () => {
      if (!hydratedRef.current) return
      const latest = latestRef.current
      if (
        !isDirty(
          latest.modelConfig,
          latest.hotkey,
          latest.closeToTray,
          latest.lookupContextMode,
          latest.kbAutoMaintain
        )
      ) {
        return
      }
      void persist(
        latest.modelConfig,
        latest.hotkey,
        latest.closeToTray,
        latest.lookupContextMode,
        latest.kbAutoMaintain
      )
    }
  }, [isDirty, persist])

  /* ---- Main render ---- */
  return (
    <div className="settings">
      <div className="settings-header">
        <div>
          <h2 className="settings-title">Settings</h2>
          <p className="settings-subtitle">
            Connections, model roles and look-up behaviour — changes save automatically.
          </p>
        </div>
        <span
          className={`settings-save-status settings-save-status--${saveStatus}`}
          role="status"
          aria-live="polite"
        >
          {SAVE_STATUS_TEXT[saveStatus]}
        </span>
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
            onHotkeyChange={setHotkey}
            hotkeyMode={hotkeyMode}
            closeToTray={closeToTray}
            onCloseToTrayChange={setCloseToTray}
            lookupContextMode={lookupContextMode}
            onLookupContextModeChange={setLookupContextMode}
            kbAutoMaintain={kbAutoMaintain}
            onKbAutoMaintainChange={setKbAutoMaintain}
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
