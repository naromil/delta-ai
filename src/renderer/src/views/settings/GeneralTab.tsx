import HotkeyInput from '../../components/settings/HotkeyInput'

interface GeneralTabProps {
  hotkey: string
  onHotkeyChange: (combo: string) => void
  closeToTray: boolean
  onCloseToTrayChange: (value: boolean) => void
}

function GeneralTab({
  hotkey,
  onHotkeyChange,
  closeToTray,
  onCloseToTrayChange
}: GeneralTabProps): React.JSX.Element {
  return (
    <>
      <HotkeyInput value={hotkey} onChange={onHotkeyChange} />
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
