import HotkeyInput from '../../components/settings/HotkeyInput'
import type { LookupContextMode, ThemeMode } from '../../../../shared/models'

interface GeneralTabProps {
  hotkey: string
  onHotkeyChange: (combo: string) => void
  hotkeyMode: 'global' | 'local'
  closeToTray: boolean
  onCloseToTrayChange: (value: boolean) => void
  lookupContextMode: LookupContextMode
  onLookupContextModeChange: (value: LookupContextMode) => void
  kbAutoMaintain: boolean
  onKbAutoMaintainChange: (value: boolean) => void
  suggestTerms: boolean
  onSuggestTermsChange: (value: boolean) => void
  theme: ThemeMode
  onThemeChange: (value: ThemeMode) => void
}

function GeneralTab({
  hotkey,
  onHotkeyChange,
  hotkeyMode,
  closeToTray,
  onCloseToTrayChange,
  lookupContextMode,
  onLookupContextModeChange,
  kbAutoMaintain,
  onKbAutoMaintainChange,
  suggestTerms,
  onSuggestTermsChange,
  theme,
  onThemeChange
}: GeneralTabProps): React.JSX.Element {
  return (
    <>
      <div className="settings-section">
        <label className="settings-label" htmlFor="theme-mode">
          Theme
        </label>
        <select
          id="theme-mode"
          className="settings-select"
          value={theme}
          onChange={(e) => onThemeChange(e.target.value as ThemeMode)}
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="system">Match system</option>
        </select>
      </div>
      <HotkeyInput value={hotkey} onChange={onHotkeyChange} mode={hotkeyMode} />
      <div className="settings-section">
        <label className="settings-label" htmlFor="lookup-context-mode">
          Look-Up Context Source
        </label>
        <select
          id="lookup-context-mode"
          className="settings-select"
          value={lookupContextMode}
          onChange={(e) => onLookupContextModeChange(e.target.value as LookupContextMode)}
        >
          <option value="none">None (no automatic context)</option>
          <option value="clipboard">Clipboard (fallback to full-screen OCR)</option>
          <option value="fullscreen-ocr">Full-screen OCR</option>
        </select>
        <p className="settings-hint">
          None opens the look-up without capturing anything; paste text or an image manually with
          Ctrl+V if needed. Clipboard mode uses copied text or an image as context. Full-screen OCR
          captures the screen every time the hotkey is pressed.
        </p>
      </div>
      <div className="settings-section">
        <label className="settings-label">Automatic memory updates</label>
        <label className="toggle-row">
          <input
            type="checkbox"
            className="toggle-input"
            checked={kbAutoMaintain}
            onChange={(e) => onKbAutoMaintainChange(e.target.checked)}
          />
          <span className="toggle-track">
            <span className="toggle-thumb" />
          </span>
          <span className="toggle-label">
            {kbAutoMaintain
              ? 'New chats update memories in the background'
              : 'Only learn when Analyze is pressed'}
          </span>
        </label>
        <p className="settings-hint">
          Delta AI periodically curates your conversations into private markdown notes, which
          personalize chats and look-ups. Runs use the Knowledge Base Maintenance model, which must
          support tool calling, and never block a look-up.
        </p>
      </div>
      <div className="settings-section">
        <label className="settings-label">Suggested terms</label>
        <label className="toggle-row">
          <input
            type="checkbox"
            className="toggle-input"
            checked={suggestTerms}
            onChange={(e) => onSuggestTermsChange(e.target.checked)}
          />
          <span className="toggle-track">
            <span className="toggle-thumb" />
          </span>
          <span className="toggle-label">
            {suggestTerms ? 'Underline terms that may be new to you' : 'No suggestions'}
          </span>
        </label>
        <p className="settings-hint">
          After each answer, the Knowledge Base Maintenance model compares it with your notes and
          underlines up to five terms to expand with one click. This makes one extra request per
          answer, and only runs once that model is assigned and notes exist.
        </p>
      </div>
      <div className="settings-section">
        <label className="settings-label">Close to system tray</label>
        <label className="toggle-row">
          <input
            type="checkbox"
            className="toggle-input"
            checked={closeToTray}
            onChange={(e) => onCloseToTrayChange(e.target.checked)}
          />
          <span className="toggle-track">
            <span className="toggle-thumb" />
          </span>
          <span className="toggle-label">
            {closeToTray ? 'Closing hides to tray' : 'Closing quits the app'}
          </span>
        </label>
      </div>
    </>
  )
}

export default GeneralTab
