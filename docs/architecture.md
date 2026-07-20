# Delta AI — Architecture

> Auto-generated from source as built. Update after major changes to provide essential context about the project.
> Last updated: 2026-07-20

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
    ├── provider.ts         Provider dispatch (callProvider, callProviderStream)
    ├── lookup/
    │   ├── lookup.ts      Orchestrator: handleHotkeyPressed entry point
    │   ├── capture.ts     Screen capture + OCR (tesseract worker)
    │   ├── handlers.ts    Paste, Ask, and Expand handlers (operate on per-session state)
    │   ├── html.ts        Inline HTML/CSS/JS for lookup popup (data: URL)
    │   ├── state.ts       Per-window LookupSession interface + helpers
    │   └── window.ts      Lookup popup window + grow animation + IPC wiring (per-session)
    └── services/
        ├── global-shortcut.ts   XDG GlobalShortcuts D-Bus (Wayland)
        └── screen-capture.ts    Freedesktop Screenshot (KDE Wayland)
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
- `handleLookupAsk(session, question)` — builds `ProviderMessage[]`, triggers grow animation on the session's window, calls `callProviderStream()`, sends streamed response to that session's popup
- `handleLookupExpand(session, payload)` — handles inline word-expansion requests from the popup's context menu. Builds a tame `ProviderMessage[]` with the original context/question + surrounding answer + the selected word, calls `callProviderStream()`, sends streamed chunks tagged with `expansionId` back to the popup
- `ExpandPayload` interface — `{ context, question, answer, selection, expansionId }`

**`state.ts`:**

- `LookupSession` — per-session mutable object: `window`, `context`, `grown`, `contextReady`, `ocrToken`, `hasText`
- `sendToSession(session, channel, ...args)` — safely sends IPC to a session's window
- `notifySessionState(session, status, text, hint)` — pushes `{ status, text, hint }` to a popup renderer
- `clamp(v, lo, hi)` — pure utility for window positioning
- `isSessionAlive(session)` — checks if a session's window is alive

**`window.ts`:**

- `createLookupSession(x, y)` — 420×320 always-on-top frameless BrowserWindow near cursor. Registers per-window IPC handlers: `lookup-ask`, `lookup-expand`, `lookup-paste-text`, `lookup-paste-image`, `lookup-close`, `lookup-input-changed`. Blur closes only if not grown AND Ask field has no text. On `closed`, removes itself from the sessions list.
- `animateGrowSession(session, w, h, targetX?, targetY?)` — easeOutCubic animation from current bounds to target. When `targetX`/`targetY` are provided, animates position as well as size. Exports `LOOKUP_GROWN_WIDTH` / `LOOKUP_GROWN_HEIGHT` for use by `handlers.ts`. Used only by the Ask flow (the first question after OCR/paste).

**`html.ts`:**

- Exports `CSS_STYLES` (separate `const`) and interpolates it into `lookUpHTML` — the inline HTML/CSS/JS loaded as a `data:` URL by each lookup session's popup.
- **Layout:** Header with "Delta AI" title and close button, Context box (`#extracted`), Ask input (`#ask`), conversation area (`#conversation`), and a hidden custom context menu (`#ctxMenu`).
- **CSS sections:** Base reset/layout, header, content area, extracted-text box, ask input, conversation turns (user/ai with framing), expansion frames (`.frame`, `.frame-inner`, `.fold-toggle`, `.queried`), and the custom context menu.
- **Context / Ask flow:**
  - `lookupOnContext(state)` drives the Context box visibility and hint text
  - Enter in the Ask input calls `w.lookupAsk(q)`, only after `contextReady` is true; early Enter flashes the box with "Context is still being prepared…"
  - `lookupInputChanged(hasText)` emitted on every `input` event to guard blur-to-close
  - `lookupOnGrow(width, height)` resizes document/body CSS height and reveals `#conversation`
- **Paste interception:** `Ctrl+V` never enters the Ask field — text pastes go to context (`w.lookupPasteText`), image pastes run OCR (`w.lookupPasteImage`)
- **Turn rendering:** `addTurn(kind, text)` appends a `.turn` div; `replaceLastAi(text)` updates the last `.turn.ai` with tokenized inline content via `renderInline()`
- **Custom context menu (`#ctxMenu`):**
  - Appears on right-click inside a `.turn.ai` with items: Expand, Copy, Select All
  - Expand is disabled when the selection spans multiple frames (prevents DOM corruption)
  - Single-word auto-selection: `caretRangeFromPoint` detects the `.word` or `.queried` span under the cursor, replaces `window.getSelection()` with that span's range
  - Drag-selection path: snapshots both the selection text (`ctxSelection`) and the live `Range` (`ctxRange`) at right-click time, before the menu-item click collapses the DOM selection
  - Copy action restores the cached range before calling `document.execCommand('copy')`
  - Ctrl+C keyboard shortcut: `keydown` listener calls `execCommand('copy')` when selection exists outside form inputs
- **Inline expansion frames:**
  - `expandSelection(selection, cachedWordSpan?, cachedRange?)` — creates a `.frame.expanded.loading` element with `data-expansion-id`, a `.frame-inner` (initially "Thinking…"), and a `.fold-toggle` button. Replaces the selected `.word` span in-place via `replaceChild`, or inserts via `range.insertNode`. Sends `w.lookupExpand({ context, question, answer, selection, expansionId })` to the main process.
    - For nested expansions (within another frame), the context/question fields are sent empty — only the parent frame's answer text is included.
    - Animates the frame in via `animateFrameIn()`.
  - `foldExpansion(id)` — replaces the `.frame` with a `.queried` pill (tinted `rgba(74,144,217,0.18)` background). The frame DOM element (including any nested sub-frames) is preserved in `expansionCache[id].frame`. Fades out via `animateFrameOut()` before the DOM swap.
  - `reexpandExpansion(id)` — replaces the `.queried` pill with the cached `.frame` element (restoring nested children intact). Falls back to recreating the frame from `cachedText` if the cache entry was invalidated.
- **Markdown processing:**
  - `flattenMarkdown(text)` — strips headings, bold/italic, inline code, links, list markers, blockquotes, horizontal rules. Produces bare inline text.
  - `tokenizeText(text)` — splits text on whitespace, wraps each word in a `.word` span (for right-click targeting).
  - `renderInline(text)` — applies `flattenMarkdown`, splits on double-newlines for paragraph breaks, tokenizes each paragraph.
- **Animations:**
  - `animateFrameIn(frame)` — sets `opacity: 0`, double `requestAnimationFrame` tick, then `opacity: 1` with CSS transition.
  - `animateFrameOut(frame, callback)` — sets `opacity: 0` with `transition: opacity 0.25s ease`, calls `callback` after 280ms.
- **Cross-frame guard:** `selectionSpansFrames(range)` compares `startContainer` and `endContainer` ancestors' innermost `.frame[data-expansion-id]`. Used in the context menu to disable Expand, and defensively in `expandSelection`'s range-insertion path.
- **Triple-click:** `mousedown` listener with `e.detail === 3` selects the innermost `.frame-inner` contents, overriding the browser's default paragraph selection.
- **Streaming expansion via IPC:**
  - `lookupOnExpandChunk(chunk)` receives `{ expansionId, text }` (or `{ expansionId, error }`). Updates `.frame-inner` with tokenized content via `renderInline()`. Removes `.loading` class. On error, sets `.error` class and hides `.fold-toggle`.
  - Each session owns its own DOM state; multiple sessions may coexist independently.

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
  // Chat / config (renderer)
  saveConfig(config) // Save single provider config
  saveAllProviders(config) // Save all providers at once
  loadConfig() // Load current provider config
  loadAllProviders() // Load all providers (for Settings caching)
  sendMessage(messages) // Send chat messages to AI
  loadSettings() // Load app settings (hotkey)
  saveSettings(settings) // Save app settings
  // Lookup popup: main → renderer (one-way)
  lookupOnContext(cb) // {status, text, hint} → lookup popup (context state)
  lookupOnChunk(cb) // Streaming AI chunk → lookup popup (plain text during stream)
  lookupOnResponse(cb) // Final AI response → lookup popup (tokenized)
  lookupOnError(cb) // Error → lookup popup
  lookupOnGrow(cb) // (width, height) → lookup popup (grow animation)
  lookupOnExpandChunk(cb) // {expansionId, text|error} → lookup popup (expansion stream)
  // Lookup popup: renderer → main
  lookupAsk(question) // Send user's question from Ask input
  lookupExpand(payload) // Request inline word expansion from context menu
  lookupPasteText(text) // Pasted text as context
  lookupPasteImage(base64) // Pasted image for OCR
  lookupInputChanged(hasText) // Whether Ask field has text (guards blur-to-close)
  lookupClose() // Close the popup
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
| Infinite recursive lookup      | ✅ Complete    |
| User knowledge base            | ❌ Not started |
| Built-in local model           | ❌ Not started |
