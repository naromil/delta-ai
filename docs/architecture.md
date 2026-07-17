# Delta AI — Architecture

> Auto-generated from source as built. Update after major changes to provide essential context about the project.
> Last updated: 2026-07-14

## High-level stack

| Layer     | Technology                                           |
| --------- | ---------------------------------------------------- |
| Shell     | Electron 34 (electron-vite 4)                        |
| Main      | TypeScript, Node.js                                  |
| Preload   | TypeScript, contextBridge                            |
| Renderer  | React 19, TypeScript, vanilla CSS                    |
| OCR       | tesseract.js (WASM)                                  |
| AI        | Multi-provider (Google AI Studio, OpenAI Compatible) |
| Packaging | electron-builder                                     |

## Project tree

```
electron.vite.config.ts      # Build orchestration (main/preload/renderer)
src/
  main/
    index.ts                 # App lifecycle, main window, provider dispatch
    config.ts                # Config persistence, Wayland detection, hotkey registry
    globalShortcutPortal.ts  # XDG GlobalShortcuts D-Bus routing (Wayland)
    screenCapturePortal.ts   # Freedesktop Screenshot D-Bus routing (KDE Wayland)
    lookup.ts                # OCR/screen-capture pipeline, lookup popup window
    lookupHTML.ts            # Inline HTML for lookup popup (data: URL, no separate file)
  preload/
    index.ts                 # contextBridge API exposed to renderer
    index.d.ts               # Type declarations for window.api & window.electron
  renderer/
    index.html               # Single-page shell (mounts #root)
    src/
      main.tsx               # ReactDOM.createRoot entry
      App.tsx                # Top-level React component (chat + settings)
      env.d.ts               # Vite env type shim
      assets/
        base.css             # CSS reset/font defaults
        main.css             # Re-exports other CSS files
        chat.css             # Chat UI styles
        settings.css         # Settings page styles
      components/
        Settings.tsx         # Settings page (categories: General, Providers)
```

## Data flow (layers)

```
Renderer (React 19)          src/renderer/src/
    │  window.api.{sendMessage, saveConfig, loadConfig, loadSettings, saveSettings,
    │              saveAllProviders, loadAllProviders}
    ▼
Preload (contextBridge)      src/preload/index.ts (+ index.d.ts)
    │  ipcRenderer.invoke(...)
    ▼
Main process (Node)          src/main/
    ├── index.ts            Provider dispatch (callProvider), callOpenAICompatible,
    │                       main window, app lifecycle
    ├── lookup.ts           OCR → AI pipeline, lookup popup BrowserWindow
    ├── config.ts           Persistence (providers.json, settings.json), Wayland
    │                       detection, global hotkey registry
    ├── globalShortcutPortal.ts  XDG GlobalShortcuts D-Bus routing (Wayland)
    └── screenCapturePortal.ts   Freedesktop Screenshot D-Bus routing (KDE Wayland)
    ▼
OS  (fs {userData}/config/, Google Gemini API / OpenAI-compatible endpoints,
     tesseract WASM, D-Bus portals, desktopCapturer)
```

## Main process architecture

The main process is split by concern across multiple files (not monolithic):

### `index.ts` — App lifecycle and provider dispatch

**Window management:**

- `createWindow()` — creates main 960×640 BrowserWindow, loads renderer

**Provider dispatch:**

- `callProvider(messages)` — reads current provider config, routes to backend
- `callOpenAICompatible(apiKey, model, messages, baseUrl)` — unified OpenAI-compatible client
  - Google AI Studio calls this with `baseUrl = 'https://generativelanguage.googleapis.com/v1beta'`
  - OpenAI Compatible provider uses user-specified `baseUrl` + `/chat/completions`
- `NoApiKeyError`, `UnsupportedProviderError` — sentinel error classes

**IPC handlers:**

- `send-message` — calls `callProvider`, returns `{ success, response?, error? }`

**Lifecycle:**

- `app.whenReady()` → creates window, registers hotkey
- `app.on('will-quit')` → unregisters shortcuts
- `app.on('window-all-closed')` → quits (except macOS)
- `app.on('activate')` → recreates window (macOS)

### `config.ts` — Configuration persistence and hotkey management

**Types:**

```typescript
interface ProviderConfig {
  apiKey: string
  model: string
  baseUrl?: string
}

interface AllProvidersConfig {
  currentProvider: string
  providers: {
    'google-ai-studio'?: ProviderConfig
    'openai-compatible'?: ProviderConfig
  }
}

interface AppSettings {
  hotkey: string
}
```

**Functions:**

- `ensureConfigDir()` — returns `{userData}/config/`, creates if missing
- `loadProviderConfig()` — reads `providers.json` → `AllProvidersConfig | null`
- `loadCurrentProviderConfig()` — returns merged `{ provider, ...ProviderConfig }` for current provider
- `loadAppSettings()` — reads `settings.json` → `AppSettings` (default `{ hotkey: 'Ctrl+Shift+D' }`)
- `saveAppSettings(settings)` — writes `settings.json`, returns `boolean`
- `registerHotkey(accelerator, onPressed)` — async; routes through XDG portal on Wayland

**IPC handlers:**

- `save-config` — updates single provider, preserves others, sets `currentProvider`
- `save-all-providers` — writes entire `AllProvidersConfig` at once
- `load-config` — returns current provider's config merged with provider name
- `load-all-providers` — returns full `AllProvidersConfig` for Settings UI
- `load-settings` — returns `AppSettings`
- `save-settings` — writes settings and re-registers hotkey

**Wayland detection:**

- `isWaylandSession()` — checks `XDG_SESSION_TYPE`, `WAYLAND_DISPLAY`, `ELECTRON_OZONE_PLATFORM_HINT`
- `isKdeWaylandSession()` — additionally checks `XDG_CURRENT_DESKTOP` for KDE

### `lookup.ts` — OCR and lookup pipeline

**Entry point:**

- `handleHotkeyPressed()` — full pipeline:
  1. Get cursor position via `screen.getCursorScreenPoint()`
  2. Capture full screen (tries portal first on KDE Wayland, falls back to `desktopCapturer`)
  3. Run OCR via tesseract.js
  4. Show lookup popup before OCR completes (for responsiveness)
  5. Send OCR text to popup, then call `callProvider()` with analysis prompt
  6. Send AI response or error to popup

**Functions:**

- `captureScreen()` — returns full-screen PNG `Buffer`
- `runOCR(imageBuffer)` — lazy-creates tesseract worker, returns OCR text
- `createLookupWindow(x, y)` — 420×320 always-on-top frameless window near cursor
- `ensureLookupWindow(x, y)` — reuses existing window or creates new
- `sendToWindow(channel, ...args)` — safely sends IPC to lookup window

**Module state:**

- `tesseractWorker` — cached worker instance
- `lookupWindow` — current lookup popup reference

### `globalShortcutPortal.ts` — XDG GlobalShortcuts for Wayland

Routes global shortcut registration through `org.freedesktop.portal.GlobalShortcuts` on Wayland sessions where Electron's `globalShortcut.register()` fails silently.

**Key functions:**

- `registerGlobalShortcutPortal(accelerator, onActivated)` — creates portal session, binds shortcut, listens for `Activated` signal
- `unregisterGlobalShortcutPortal()` — closes session on quit/settings change
- `electronToGtkAccel(accelerator)` — converts Electron format (`Ctrl+Shift+D`) to GTK format (`<Control><Shift>D`)

### `screenCapturePortal.ts` — Freedesktop Screenshot for KDE Wayland

**Why it exists:** On KDE Plasma Wayland, `desktopCapturer.getSources()` shows a "Choose what to share" prompt on every call, and the "remember my choice" checkbox is broken. The `Screenshot` portal with `interactive=false` captures silently after one-time consent.

**Key functions:**

- `captureScreenViaPortal()` — returns PNG `Buffer` from portal temp file
- `isScreenCapturePortalPreferred()` — returns `true` only on KDE Wayland

## Preload (`src/preload/index.ts`)

Exposes via `contextBridge`:

**`window.electron`** — `@electron-toolkit/preload` API

**`window.api`** — custom IPC bridge:

```typescript
{
  saveConfig(config) // Save single provider config
  saveAllProviders(config) // Save all providers at once
  loadConfig() // Load current provider config
  loadAllProviders() // Load all providers (for Settings caching)
  sendMessage(messages) // Send chat messages to AI
  loadSettings() // Load app settings (hotkey)
  saveSettings(settings) // Save app settings
  lookupOnOcr(cb) // One-way: OCR result → lookup popup
  lookupOnResponse(cb) // One-way: AI response → lookup popup
  lookupOnError(cb) // One-way: Error → lookup popup
  lookupClose() // Close lookup popup
}
```

## Renderer (`src/renderer/src/`)

### `App.tsx` — Main application shell

**State:**

- `view: 'chat' | 'settings'`
- `messages: Message[]` — chat history
- `input: string` — composer textarea
- `loading: boolean` — AI response in progress

**Behavior:**

- Sidebar with "New chat" button (clears messages) and Settings toggle
- Chat view: message list with auto-scroll, composer with Enter-to-send
- Settings view: renders `<Settings onBack={() => setView('chat')} />`

### `Settings.tsx` — Provider and hotkey configuration

**Structure:**

- **Category tabs** (animation on switch):
  - **General** — Global hotkey configuration (key capture input)
  - **Providers** — Provider selection and credentials

**Provider fields:**

- **Google AI Studio**: API key, model dropdown (presets + custom), custom model text input
- **OpenAI Compatible**: API key, base URL text input, model ID text input (no presets)

**Caching behavior:**

- All provider configs cached in-memory on mount via `loadAllProviders()`
- Switching providers loads cached config instantly (no disk I/O)
- All cached configs saved to disk together on Save button press

**Key functions:**

- `resolveModel(provider)` — returns effective model string
- `flushToCache()` — writes current form state to in-memory cache
- `loadFromCache(provider)` — loads cached config into form fields
- `switchProvider(provider)` — flushes current, loads target provider
- `handleSave()` — flushes all providers to disk via `saveAllProviders()`

**Leaf utilities extracted to module level:**

- `renderCombo(e)` — keyboard event → Electron accelerator string

### CSS architecture

Files in `assets/`:

- `base.css` — CSS reset, `:root` color variables
- `chat.css` — sidebar, message list, composer styles
- `settings.css` — settings page, category tabs, form inputs
- `main.css` — re-exports all other CSS files

## Configuration file format

**`{userData}/config/providers.json`:**

```json
{
  "currentProvider": "google-ai-studio",
  "providers": {
    "google-ai-studio": {
      "apiKey": "...",
      "model": "gemini-3.5-flash"
    },
    "openai-compatible": {
      "apiKey": "...",
      "model": "gpt-4",
      "baseUrl": "https://api.example.com/v1"
    }
  }
}
```

**`{userData}/config/settings.json`:**

```json
{
  "hotkey": "Ctrl+Shift+D"
}
```

## Build pipeline (`electron-vite`)

```
electron.vite.config.ts
  ├── main    → out/main/index.js    (SSR, cjs)
  ├── preload → out/preload/index.js (SSR, cjs)
  └── renderer→ out/renderer/        (client, esm + HTML + CSS)
```

`npm run build` runs `typecheck:node` + `typecheck:web` (both `tsc --noEmit`), then `electron-vite build`.

## Platform-specific behavior

| Platform              | Hotkey registration         | Screen capture                 |
| --------------------- | --------------------------- | ------------------------------ |
| X11 / macOS / Windows | `globalShortcut.register()` | `desktopCapturer.getSources()` |
| KDE Plasma Wayland    | XDG GlobalShortcuts portal  | Screenshot portal (silent)     |
| GNOME / Other Wayland | XDG GlobalShortcuts portal  | `desktopCapturer.getSources()` |

## Current feature status

| Feature                        | Status         |
| ------------------------------ | -------------- |
| ChatGPT-like chat UI           | ✅ Complete    |
| Settings with category tabs    | ✅ Complete    |
| Multi-provider config (cached) | ✅ Complete    |
| Google AI Studio provider      | ✅ Complete    |
| OpenAI Compatible provider     | ✅ Complete    |
| OCR from screen (full capture) | ✅ Complete    |
| AI explanation popup           | ✅ Complete    |
| Global hotkey (X11 + Wayland)  | ✅ Complete    |
| Infinite recursive lookup      | ❌ Not started |
| User knowledge base            | ❌ Not started |
| Built-in local model           | ❌ Not started |
