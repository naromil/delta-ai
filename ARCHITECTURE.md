# Delta AI — Architecture

> Auto-generated from source as built. Update after major changes to prevent hallucination.
> Last updated: 2026-07-11

## High-level stack

| Layer     | Technology                        |
| --------- | --------------------------------- |
| Shell     | Electron 34 (electron-vite 4)     |
| Main      | TypeScript, Node.js               |
| Preload   | TypeScript, contextBridge         |
| Renderer  | React 19, TypeScript, vanilla CSS |
| OCR       | tesseract.js (WASM)               |
| AI        | Google Gemini API (BYOK)          |
| Packaging | electron-builder                  |

## Project tree (only non-generated / non-config)

```
electron.vite.config.ts      # Build orchestration (main/preload/renderer)
src/
  main/
    index.ts                 # All main-process logic
    config.ts                # Persistence + Wayland detection + hotkey registry
    globalShortcutPortal.ts  # XDG GlobalShortcuts D-Bus routing for Wayland
    screenCapturePortal.ts   # Freedesktop Screenshot D-Bus routing for KDE Wayland
    lookup.ts                # OCR / screen-capture / AI pipeline + lookup popup
    lookupHTML.ts            # Inline HTML for the lookup popup window
  preload/
    index.ts                 # contextBridge API exposed to renderer
    index.d.ts               # Type declarations for window.api & window.electron
  renderer/
    index.html               # Single-page shell (mounts #root)
    src/
      main.tsx               # ReactDOM.createRoot entry
      App.tsx                # Top-level React component (chat layout)
      env.d.ts               # Vite env type shim
      assets/
        base.css             # CSS reset/font defaults
        main.css             # All app styles (sidebar, chat, settings, overlay)
      components/
        Settings.tsx         # Settings page (API key, model, hotkey)
```

## Data flow (layers)

```
Renderer (React)
    │  window.api.{loadConfig, saveConfig, sendMessage, loadSettings, saveSettings}
    ▼
Preload (contextBridge)
    │  ipcRenderer.invoke('save-config', ...) etc.
    ▼
Main process
    │  fs read/write config.json + settings.json
    │  fetch → Google Gemini API
    │  tesseract.recognize()
    │  captureRegionAroundCursor()
    │      ├── (KDE Wayland) org.freedesktop.portal.Screenshot  → NativeImage.crop() → .toPNG()
    │      └── (else)        desktopCapturer.getSources()       → NativeImage.crop() → .toPNG()
    │  globalShortcut.register() / org.freedesktop.portal.GlobalShortcuts
    │  BrowserWindow (main chat + popup overlay)
    ▼
OS
```

## Main process (`src/main/index.ts`)

All long-running / privileged code lives in a single file. Key functions:

### Persistence

- **`ensureConfigDir()`** — returns `{userData}/config/`, creates if missing.
- **`loadProviderConfig()`** — reads `config.json` → `ProviderConfig | null`.
- **`loadAppSettings()`** — reads `settings.json` → `AppSettings` (default `{ hotkey: 'Ctrl+Shift+D' }`).
- **`saveAppSettings(settings)`** — writes `settings.json`, returns `boolean`.

### AI

- **`callGoogleAI(messages, apiKey, model)`** — `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`. Returns response text or throws.

### OCR / screen capture

- **`captureScreenImage(display)`** (in `lookup.ts`) — fetches the current screen as a `NativeImage` matching `display`. On KDE Plasma Wayland, first tries `org.freedesktop.portal.Screenshot` (interactive=false) through the D-Bus portal (see `src/main/screenCapturePortal.ts`) — silent after one-time consent, avoiding the persistent "choose what to share" prompt that every `desktopCapturer` call shows on Plasma Wayland (and whose "remember my choice" checkbox is broken at the portal-impl level). Falls back to Electron's `desktopCapturer.getSources()` everywhere else — which the user expects on X11 / Windows / macOS, and on non-KDE Wayland compositors whose remember-choice checkbox actually works.
- **`captureRegionAroundCursor(width=400, height=150)`** — calls `captureScreenImage`, then crops a rectangle centered on the cursor position relative to the display. Uses the source image's own dimensions (`imgW`/`imgH`) so the crop math is robust to either source returning at native or scaled resolution. Returns PNG `Buffer`.
- **`runOCR(imageBuffer)`** — creates a tesseract worker, calls `recognize(imageBuffer)`, returns concatenated text.

### Popup overlay

- **`createPopupWindow(x, y)`** — creates a frameless, always-on-top, non-resizable `BrowserWindow` (600×400) positioned at `(x, y)`. Loads `out/renderer/popup.html` (a separate Vite entry built by `electron-vite`). Auto-closes on blur (1.5s polling via `setInterval` checking `isFocused()`).

### Hotkey

- **`registerHotkey(accelerator)`** — async. On a native Wayland session it routes through the XDG Desktop Portal `GlobalShortcuts` backend (`src/main/globalShortcutPortal.ts`): creates a portal session, binds the accelerator (Electron `Ctrl+Shift+D` → GTK `<Control><Shift>D`), and listens for the portal's `Activated` signal. On X11/macOS/Windows it falls back to Electron's `globalShortcut.register`. Either way, on success it wires the press to `handleHotkeyPressed`; on failure it logs a warning (on KDE/GNOME the shortcut may need a one-time assignment in the desktop's Global Shortcuts settings, keyed by the app's `.desktop` id `com.deltaai.app`).
- **`handleHotkeyPressed()`** — full pipeline:
  1. Capture region around cursor (400×150).
  2. OCR the image.
  3. If no text found, show popup with fallback message.
  4. If text found, call `callGoogleAI` with a system prompt asking to explain the term.
  5. Show popup window positioned near cursor displaying AI response.

### Window management

- **`createWindow()`** — creates the main renderer window (900×670, min 800×600). Loads renderer entry point. Registers default hotkey from `settings.json`. Sets up IPC handlers:
  - `save-config` — writes provider config to `config.json`.
  - `load-config` — reads `config.json`.
  - `send-message` — forwards chat messages to AI provider (currently only Google AI Studio).
  - `load-settings` — reads `settings.json`.
  - `save-settings` — writes `settings.json` AND re-registers the global shortcut with the new accelerator.

### Types (inline in main/index.ts)

- `ProviderConfig { provider, apiKey, model }`
- `AppSettings { hotkey }`
- `ChatMessage { role, content }`

### Startup

- `app.whenReady()` → `createWindow()`.
- `app.on('window-all-closed')` → unregister all shortcuts, quit (except macOS).
- `app.on('activate')` → recreate window if none exist (macOS).

## Preload (`src/preload/index.ts`)

Exposes two globals on `window`:

- **`window.electron`** — standard `@electron-toolkit/preload` API (versions, platform, etc.).
- **`window.api`** — custom IPC bridge:
  - `saveConfig(config)` → `ipcRenderer.invoke('save-config', config)`
  - `loadConfig()` → `ipcRenderer.invoke('load-config')`
  - `sendMessage(messages)` → `ipcRenderer.invoke('send-message', messages)`
  - `loadSettings()` → `ipcRenderer.invoke('load-settings')`
  - `saveSettings(settings)` → `ipcRenderer.invoke('save-settings', settings)`

Supports both context-isolated and non-isolated modes (if-check).

## Renderer (`src/renderer/src/`)

### Entry: `main.tsx`

Standard React 19 root render into `#root` with `<StrictMode>`.

### `App.tsx`

Single top-level component managing three views:

- **`chat`** — the default ChatGPT-like chat UI.
- **`settings`** — provider/hotkey configuration.
- **`overlay`** — popup overlay (used in the separate popup window, not the main window).

State:

- `currentView` — `'chat' | 'settings'`
- `messages` — chat message array `{ role, content }[]` with default welcome message.
- `inputValue` — textarea value.
- `running` — loading spinner while AI responds.

Key behavior:

- Sends user message + full history to `window.api.sendMessage()`.
- Streaming response — full message replaced on completion.
- Enter to send, Shift+Enter for newline.
- Auto-scrolls to latest message.
- Settings gear icon in sidebar toggles between `chat` and `settings` views.

The popup overlay is a separate window (`popup.html`) that uses the same `App` component in `overlay` view — it reads the overlay text passed via `window.__overlayText` (set by the popup HTML page before React mounts).

### `Settings.tsx`

Controlled form for:

- **Provider** — dropdown (currently only Google AI Studio).
- **API Key** — password input.
- **Model** — dropdown with preset Google models + "Custom..." option with text input.
- **Global Hotkey** — text input + "Set" button, saves via `window.api.saveSettings()`.

On mount, loads existing config from `window.api.loadConfig()` and settings from `window.api.loadSettings()`. Save button writes full provider config to `config.json`.

### `assets/main.css`

All app CSS (504 lines). Variables defined in `:root`:

- `--chat-sidebar-bg: #171717`
- `--chat-bg: #212121`
- `--chat-border: rgba(255,255,255,0.08)`
- `--chat-input-bg: #2f2f2f`
- `--chat-hover: #2a2a2a`
- `--chat-accent: #ffffff`
- `--chat-muted: rgba(255,255,255,0.45)`

### Removed files

- `Versions.tsx` — the default electron-vite component (deleted).
- `electron.svg` / `wavy-lines.svg` — default decorative assets (kept on disk but unused).

### Popup HTML

A separate entry point (`popup.html`) built by `electron-vite` that loads a lightweight React mount. The popup window displays AI lookup results near the cursor after the OCR → AI pipeline completes.

## Build pipeline (`electron-vite`)

```
electron.vite.config.ts
  ├── main    → out/main/index.js    (SSR, cjs)
  ├── preload → out/preload/index.js (SSR, cjs)
  └── renderer→ out/renderer/        (client, esm + HTML + CSS)
                 └── popup.html (additional entry)
```

`npm run build` runs `typecheck:node` + `typecheck:web` first (both `tsc --noEmit`), then `electron-vite build`.

## Future (from README.md)

- **Look-Up Feature**: infinite recursive term expansion inside the popup overlay.
- **Knowledge Base**: local user profile (learning preferences, knowledge range, personality) — summarized before sending to cloud providers.
- **Personalized explanations**: use knowledge base data to optimize AI prompts.
- **Knowledge base management UI**: users can view and manage their AI models and knowledge bases.
- **Built-in model**: a local model to decide what information is necessary to send (privacy-preserving summarization).

## Current feature status

| Feature                           | Status            |
| --------------------------------- | ----------------- |
| ChatGPT-like chat UI              | ✅ Complete       |
| Settings (API key, model, hotkey) | ✅ Complete       |
| OCR from screen region            | ✅ Complete       |
| AI explanation popup              | ✅ Complete       |
| Global hotkey                     | ✅ Complete       |
| Infinite recursive lookup         | ❌ Not started    |
| User knowledge base               | ❌ Not started    |
| Built-in local model              | ❌ Not started    |
| Multi-provider support            | ❌ Only Google AI |
