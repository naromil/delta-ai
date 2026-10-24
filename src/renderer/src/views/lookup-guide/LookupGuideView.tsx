import { useState, useEffect, useCallback } from 'react'
import type { LookupContextMode } from '../../../../shared/models'

const GUIDE_SECTIONS = [
  {
    title: 'Triggering the Look-Up',
    description: [
      'Press the global hotkey (default Ctrl+Shift+D) anywhere to open the Look-Up popup.',
      'The popup appears near your cursor as a small floating window.',
      'On Wayland / KDE the position may be centered by the compositor.'
    ]
  },
  {
    title: 'Context Panel',
    description: [
      'The context panel at the top shows what the AI will see alongside your question.',
      'In Clipboard mode, text or images from your clipboard are used as context.',
      'In Fullscreen OCR mode, your screen is captured and OCR extracts text from it.',
      'You can also paste text or images manually with Ctrl+V to replace the context.'
    ]
  },
  {
    title: 'Asking Questions',
    description: [
      'Type your question in the Ask field and press Enter.',
      'If the field is empty, pressing Enter sends "summarize" as a default query.',
      'The first question triggers a window expansion to show the conversation.',
      'Once expanded, the window stays open on blur so you can keep consulting it.'
    ]
  },
  {
    title: 'Conversation & Responses',
    description: [
      'AI responses appear below the input in a conversation view.',
      'You can right-click any word or selection to expand it with a definition.',
      'Use "Expand on\u2026" to ask a custom follow-up about the selected text.',
      'Press Escape to dismiss menus or to close the window when the Ask field is empty.'
    ]
  },
  {
    title: 'Transfer to Chat',
    description: [
      'Click the + button in the header to send the entire conversation to the main chat window.',
      'The screen context is automatically included as the first user message.',
      'Once transferred, the conversation is persisted and searchable from the chat sidebar.'
    ]
  }
]

const MODE_LABELS: Record<LookupContextMode, string> = {
  clipboard: 'Clipboard',
  'fullscreen-ocr': 'Fullscreen OCR'
}

const MODE_DESCRIPTIONS: Record<LookupContextMode, string> = {
  clipboard:
    'Use clipboard content as context. Falls back to fullscreen OCR if the clipboard is empty.',
  'fullscreen-ocr': 'Capture the entire screen and run OCR on it every time.'
}

function LookupGuideView(): React.JSX.Element {
  const [contextMode, setContextMode] = useState<LookupContextMode>('clipboard')
  const [modesLoaded, setModesLoaded] = useState(false)

  useEffect(() => {
    window.api.loadSettings().then((s) => {
      const settings = s as { lookupContextMode?: string } | null
      if (
        settings?.lookupContextMode === 'clipboard' ||
        settings?.lookupContextMode === 'fullscreen-ocr'
      ) {
        setContextMode(settings.lookupContextMode)
      }
      setModesLoaded(true)
    })
  }, [])

  const handleModeChange = useCallback(async (mode: LookupContextMode) => {
    setContextMode(mode)
    const settings = (await window.api.loadSettings()) as {
      hotkey: string
      closeToTray: boolean
      lookupContextMode: string
      kbAutoMaintain: boolean
    }
    await window.api.saveSettings({ ...settings, lookupContextMode: mode })
  }, [])

  return (
    <div className="view-shell">
      <div className="view-shell-header">
        <h1>Look-Up Guide</h1>
        <p className="view-shell-subtitle">
          Press the hotkey anywhere to capture what is on screen and ask about it, without leaving
          what you are doing.
        </p>
      </div>
      <div className="view-shell-content">
        <div className="lookup-guide-sections">
          {GUIDE_SECTIONS.map((section, index) => (
            <div key={section.title} className="lookup-guide-section">
              <h2 className="lookup-guide-section-title">
                <span className="lookup-guide-step">{index + 1}</span>
                {section.title}
              </h2>
              <ul className="lookup-guide-section-list">
                {section.description.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="lookup-guide-divider" />

        <div className="lookup-guide-mode-section">
          <h2 className="lookup-guide-section-title">Context Mode</h2>
          <p className="lookup-guide-mode-hint">
            Choose how the Look-Up popup acquires its context when the hotkey is pressed.
          </p>
          <div className="lookup-guide-mode-toggle">
            {(['clipboard', 'fullscreen-ocr'] as LookupContextMode[]).map((mode) => (
              <button
                key={mode}
                className={`lookup-guide-mode-option${contextMode === mode ? ' active' : ''}`}
                disabled={!modesLoaded}
                onClick={() => handleModeChange(mode)}
              >
                <span className="lookup-guide-mode-option-label">{MODE_LABELS[mode]}</span>
                <span className="lookup-guide-mode-option-desc">{MODE_DESCRIPTIONS[mode]}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export default LookupGuideView
