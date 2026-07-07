import { useState } from 'react'
import Versions from './components/Versions'
import electronLogo from './assets/electron.svg'

function App(): React.JSX.Element {
  const ipcHandle = (): void => window.electron.ipcRenderer.send('ping')
  const [text, setText] = useState('')
  const [wordCount, setWordCount] = useState<number | null>(null)

  const handleCountWords = (): void => {
    const trimmed = text.trim()
    setWordCount(trimmed === '' ? 0 : trimmed.split(/\s+/).length)
  }

  return (
    <>
      <img alt="logo" className="logo" src={electronLogo} />
      <div className="creator">Powered by electron-vite</div>
      <div className="text">
        Build an Electron app with <span className="react">React</span>
        &nbsp;and <span className="ts">TypeScript</span>
      </div>
      <p className="tip">
        Please try pressing <code>F12</code> to open the devTool
      </p>
      <div className="word-counter">
        <textarea
          className="word-counter-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type some words..."
          rows={4}
        />
        <button className="word-counter-button" onClick={handleCountWords}>
          Count Words
        </button>
        {wordCount !== null && (
          <label className="word-counter-label">Word count: {wordCount}</label>
        )}
      </div>
      <div className="actions">
        <div className="action">
          <a href="https://electron-vite.org/" target="_blank" rel="noreferrer">
            Documentation
          </a>
        </div>
        <div className="action">
          <a target="_blank" rel="noreferrer" onClick={ipcHandle}>
            Send IPC
          </a>
        </div>
      </div>
      <Versions></Versions>
    </>
  )
}

export default App
