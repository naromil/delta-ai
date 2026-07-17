# Delta AI — Architecture

> Auto-generated from source as built. Update after major changes to provide essential context about the project.
> Last updated: 2026-07-17

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
    index.ts                 # App lifecycle, main window, send-message IPC handler
    config.ts                # Config persistence, Wayland detection, hotkey registry
    provider.ts              # Provider dispatch (callProvider + callOpenAICompatible)
    lookup/
      lookup.ts              # Orchestrator: IPC wiring + handleHotkeyPressed entry point
      capture.ts             # Screen capture + OCR pipeline (tesseract.js worker)
      handlers.ts            # Paste handlers + Ask handler (builds messages, calls provider)
      html.ts                # Inline HTML for lookup popup (data: URL)
      state.ts               # Shared mutable state (lookupState object + helpers)
      window.ts              # Lookup popup BrowserWindow creation + grow animation
    services/
      global-shortcut.ts     # XDG GlobalShortcuts D-Bus routing (Wayland)
      screen-capture.ts      # Freedesktop Screenshot D-Bus routing (KDE Wayland)
  preload/
    index.ts                 # contextBridge API exposed to renderer
    index.d.ts               # Type declarations for window.api & window.electron
  renderer/
    index.html               # Single-page shell (mounts #root)
    src/
      main.tsx               # ReactDOM.createRoot entry
      App.tsx                # Shell: sidebar + view routing + send orchestration
      env.d.ts               # Vite env type shim
      assets/
        base.css             # CSS reset/font defaults
        main.css             # Re-exports other CSS files
        chat.css             # Chat UI styles
        settings.css         # Settings page styles
      views/
        chat/
          ChatView.tsx       # Message list + empty state + composer + auto-scroll
        settings/
          Settings.tsx       # Settings page orchestrator (categories + cache + save)
      components/
        settings/
          HotkeyInput.tsx    # Hotkey capture input with keyboard combo rendering
          GoogleAiForm.tsx   # Google AI Studio provider config form
          OpenAiForm.tsx     # OpenAI Compatible provider config form
```

## Data flow (layers)

```
Renderer (React 19)          src/renderer/src/
    │  window.api.{sendMessage, saveConfig, loadConfig, loadSettings, saveSettings,
    │              saveAllProviders, loadAllProviders}
    ▼
Preload (contextBridge)      src/preload/index.ts (+ index.d.ts)
    │  ipcRenderer.invoke(...) / ipcRenderer.send(...) / ipcRenderer.on(...)
    ▼
Main process (Node)          src/main/
    ├── index.ts            App lifecycle + main window + send-message IPC
    ├── config.ts           Config persistence, Wayland detection, hotkey registry
    ├── provider.ts         Provider dispatch (callProvider, callOpenAICompatible)
    ├── lookup/
    │   ├── lookup.ts      Orchestrator: handleHotkeyPressed entry point
    │   ├── capture.ts     Screen capture + OCR (tesseract worker)
    │   ├── handlers.ts    Paste + Ask handlers (operate on per-session state)
    │   ├── state.ts       Per-window LookupSession interface + helpers
    │   └── window.ts      Lookup popup window + grow animation (per-session)
    └── services/
        ├── global-shortcut.ts   XDG GlobalShortcuts D-Bus (Wayland)
        └── screen-capture.ts    Freedesktop Screenshot D-Bus (KDE Wayland)
    ▼
OS  (fs {userData}/config/, Google Gemini API / OpenAI-compatible endpoints,
     tesseract WASM, D-Bus portals, desktopCapturer)
```

## Main process architecture

The main process is split by concern across multiple files (not monolithic):

### `index.ts` — App lifecycle and main window

**Window management:**

- `createWindow()` — creates main 960×640 BrowserWindow, loads renderer

**IPC handlers:**

- `send-message` — calls `callProvider` from `provider.ts`, returns `{ success, response?, error? }`

**Lifecycle:**

- `app.whenReady()` → creates window, registers hotkey
- `app.on('will-quit')` → unregisters shortcuts
- `app.on('window-all-closed')` → quits (except macOS)
- `app.on('activate')` → recreates window (macOS)

### `provider.ts` — Provider dispatch

- `callProvider(messages)` — reads current provider config via `loadCurrentProviderConfig()` from `config.ts`, routes to backend
- `callOpenAICompatible(apiKey, model, messages, baseUrl)` — unified OpenAI-compatible client
  - Google AI Studio calls this with `baseUrl = 'https://generativelanguage.googleapis.com/v1beta'`
  - OpenAI Compatible provider uses user-specified `baseUrl` + `/chat/completions`
- `NoApiKeyError`, `UnsupportedProviderError` — sentinel error classes

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

### `lookup/` — OCR and lookup pipeline (subdirectory)

Each hotkey press spawns a new lookup session; once a session has grown (a message was sent)
it no longer closes on blur, so multiple lookup windows may coexist. State lives on a
per-window `LookupSession` object in `state.ts`; handlers operate on the passed-in session.

**`lookup.ts` (orchestrator):**

- `handleHotkeyPressed()` — hotkey entry point:
  1. Get cursor position via `screen.getCursorScreenPoint()`
  2. Capture full screen (delegates to `capture.ts`)
  3. Create a new popup session (delegates to `window.ts`); previous sessions stay open
  4. Run OCR via tesseract.js (delegates to `capture.ts`). Bumps the session's `ocrToken` before OCR; if a paste supersedes it, the stale result is discarded.
  5. Notify the popup of context state via `notifySessionState`

**`capture.ts`:**

- `captureScreen()` — returns full-screen PNG `Buffer` (portal first on KDE Wayland, `desktopCapturer` fallback)
- `runOCR(imageBuffer)` — lazy-creates tesseract worker, returns OCR text
- `runOCRTokenedFor(session, imageBuffer)` — bumps session's `ocrToken`, runs OCR; returns `null` if the token was superseded while OCR was in flight

**`handlers.ts`:**

- `handlePasteText(session, text)` — bumps session token, sets text as context, marks ready
- `handlePasteImage(session, base64)` — bumps session token, runs OCR on image via `runOCRTokenedFor`, marks ready
- `handleLookupAsk(session, question)` — builds `ProviderMessage[]`, triggers grow animation on the session's window, calls `callProvider()`, sends response to that session's popup

**`state.ts`:**

- `LookupSession` — per-session mutable object: `window`, `context`, `grown`, `contextReady`, `ocrToken`, `hasText`
- `sendToSession(session, channel, ...args)` — safely sends IPC to a session's window
- `notifySessionState(session, status, text, hint)` — pushes `{ status, text, hint }` to a popup renderer
- `clamp(v, lo, hi)` — pure utility for window positioning
- `isSessionAlive(session)` — checks if a session's window is alive

**`window.ts`:**

- `createLookupSession(x, y)` — 420×320 always-on-top frameless BrowserWindow near cursor. Registers per-window IPC handlers. Blur closes only if not grown AND Ask field has no text (guard). On `closed`, removes itself from the sessions list. Listens for `lookup-close` and `lookup-input-changed` IPC.
- `animateGrowSession(session, w, h)` — easeOutCubic animation expanding from the window's current position to 840×640. Exports `LOOKUP_GROWN_WIDTH` / `LOOKUP_GROWN_HEIGHT` for use by `handlers.ts`.

**`html.ts`:**

- Exports `lookUpHTML` — the inline HTML/JS loaded as a `data:` URL by each lookup session's popup. Key behaviors:
  - Shows a "Context" box (driven by `lookupOnContext`) and an "Ask DeltaAI…" input
  - Enter sends the question, but only when `contextReady` is true (the `lookupOnContext` callback gates it); pressing Enter too early flashes the box with "Context is still being prepared…"
  - Paste intercept: `Ctrl+V` never enters the Ask field; text pastes go to the context (via `lookupPasteText`), image pastes run OCR on the clipboard image (via `lookupPasteImage`)
  - `lookupInputChanged(hasText)` is emitted on every `input` event to tell main whether the Ask field has text (guards blur-to-close in `window.ts`)
  - `lookupOnGrow(width, height)` resizes the document/body CSS height and reveals the conversation area; auto-focuses the input after the grow animation completes
  - Each session owns its own DOM state; multiple sessions may coexist independently

### `services/global-shortcut.ts` — XDG GlobalShortcuts for Wayland

Routes global shortcut registration through `org.freedesktop.portal.GlobalShortcuts` on Wayland sessions where Electron's `globalShortcut.register()` fails silently.

**Key functions:**

- `registerGlobalShortcutPortal(accelerator, onActivated)` — creates portal session, binds shortcut, listens for `Activated` signal
- `unregisterGlobalShortcutPortal()` — closes session on quit/settings change
- `electronToGtkAccel(accelerator)` — converts Electron format (`Ctrl+Shift+D`) to GTK format (`<Control><Shift>D`)

### `services/screen-capture.ts` — Freedesktop Screenshot for KDE Wayland

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
  saveConfig(config)                // Save single provider config
  saveAllProviders(config)          // Save all providers at once
  loadConfig()                      // Load current provider config
  loadAllProviders()                // Load all providers (for Settings caching)
  sendMessage(messages)             // Send chat messages to AI
  loadSettings()                    // Load app settings (hotkey)
  saveSettings(settings)            // Save app settings
  lookupOnContext(cb)               // One-way: {status, text, hint} → lookup popup (context state)
  lookupOnResponse(cb)              // One-way: AI response → lookup popup
  lookupOnError(cb)                 // One-way: Error → lookup popup
  lookupOnGrow(cb)                  // One-way: (width, height) → lookup popup (grow animation)
  lookupAsk(question)               // Renderer→main: send user's question
  lookupPasteText(text)             // Renderer→main: pasted text as context
  lookupPasteImage(base64)          // Renderer→main: pasted image for OCR
  lookupInputChanged(hasText)       // Renderer→main: whether Ask field has text (guards blur-to-close)
  lookupClose()                     // Renderer→main: close the popup
}
```

## Renderer (`src/renderer/src/`)

### `App.tsx` — Application shell

**State:**

- `view: 'chat' | 'settings'` — which view is showing
- `messages: Message[]` — chat history
- `loading: boolean` — AI response in progress

**Behavior:**

- Sidebar with "New chat" button (clears messages) and Settings toggle
- `handleSend(content)` — creates user/assistant messages, calls `window.api.sendMessage()`, updates state
- Routes view: renders `<Settings>` or `<ChatView>` based on `view` state

### `views/chat/ChatView.tsx` — Chat message list and composer

**Props:** `messages`, `loading`, `onSend`

**Owns:**

- `input` state for the textarea
- Auto-scroll to bottom on new messages
- Empty state (`"How can I help you today?"`)
- Message list with role avatars and loading-dots animation
- Composer with Enter-to-send and send button

### `views/settings/Settings.tsx` — Settings orchestrator

**State:** All settings form fields, cache ref, save state

**Behavior:**

- **Category tabs** (animation on switch):
  - **General** — Renders `<HotkeyInput>`
  - **Providers** — Provider selector dropdown, renders `<GoogleAiForm>` or `<OpenAiForm>`
- Cache management: `flushToCache()` / `loadFromCache()` / `switchProvider()`
- `handleSave()` — flushes all providers to disk via `saveAllProviders()` + `saveSettings()`

### `components/settings/HotkeyInput.tsx` — Hotkey capture input

**Props:** `value`, `onChange`

**Owns:**

- `capturing` state for focus/blur toggle
- `renderCombo(e)` — keyboard event → Electron accelerator string
- ReadOnly input that captures key combination when focused

### `components/settings/GoogleAiForm.tsx` — Google AI Studio form

**Props:** `apiKey`, `model`, `customModel`, `isCustomModel`, plus `on*Change` callbacks, `onDirty`

**Renders:**

- API key password input
- Model dropdown (presets: gemini-3.5-flash, gemini-3.1-pro, etc. + "Custom...")
- Conditional custom model text input

### `components/settings/OpenAiForm.tsx` — OpenAI Compatible form

**Props:** `apiKey`, `baseUrl`, `customModel`, plus `on*Change` callbacks, `onDirty`

**Renders:**

- API key password input
- Base URL text input
- Model ID text input

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
