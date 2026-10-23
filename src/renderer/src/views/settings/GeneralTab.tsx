import HotkeyInput from '../../components/settings/HotkeyInput'
import type { LookupContextMode } from '../../../../shared/models'

interface GeneralTabProps {
  hotkey: string
  onHotkeyChange: (combo: string) => void
  hotkeyMode: 'global' | 'local'
  closeToTray: boolean
  onCloseToTrayChange: (value: boolean) => void
  lookupContextMode: LookupContextMode
  onLookupContextModeChange: (value: LookupContextMode) => void
}

function GeneralTab({
  hotkey,
  onHotkeyChange,
  hotkeyMode,
  closeToTray,
  onCloseToTrayChange,
  lookupContextMode,
  onLookupContextModeChange
}: GeneralTabProps): React.JSX.Element {
  return (
    <>
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
          <option value="clipboard">Clipboard (fallback to full-screen OCR)</option>
          <option value="fullscreen-ocr">Full-screen OCR</option>
        </select>
        <p className="settings-hint">
          Clipboard mode uses copied text or an image as context. Full-screen OCR captures the
          screen every time the look-up hotkey is pressed.
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
