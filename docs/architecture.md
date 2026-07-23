# Delta AI — Architecture

> Auto-generated from source as built. Update after major changes to provide essential context about the project.
> Last updated: 2026-07-23

## High-level stack

| Layer     | Technology                                                                               |
| --------- | ---------------------------------------------------------------------------------------- |
| Shell     | Electron 34 (electron-vite 4)                                                            |
| Main      | TypeScript, Node.js                                                                      |
| Preload   | TypeScript, contextBridge                                                                |
| Shared    | TypeScript (pure types + helpers, no runtime deps)                                       |
| Renderer  | React 19, TypeScript, vanilla CSS                                                        |
| OCR       | tesseract.js (WASM)                                                                      |
| AI        | Multi-provider (Google AI Studio, OpenAI Compatible; OpenAI, Ollama, OpenRouter planned) |
| Packaging | electron-builder                                                                         |

## Project tree

```
electron.vite.config.ts      # Build orchestration (main/preload/renderer — single renderer bundle,
                              #   lookup popup loaded via ?role=lookup on the same bundle)
src/
  shared/
    models.ts                 # Shared types + provider/role registries (no runtime deps)
    conversation.ts           # ConversationState model + helpers (tokenize, insertExpansion,
                              #   updateExpansionInSegments, findExpansionParent, serializeForChat, etc.)
    expand-prompt.ts          # Shared buildExpandMessages helper (constructs API messages for expand,
                              #   supports optional prompt for custom direction)
    prompts.ts                # All LLM-facing prompt strings: system prompts (CHAT/LOOKUP), context
                              #   template, expand instructions (default + prompted), lookup defaults
  main/
    index.ts                  # App lifecycle, main window, streaming IPC handlers (chat-send,
                              #   chat-expand, lookup-trigger-grow, lookup-transfer)
    main-window.ts            # Module-scoped getter/setter for the main BrowserWindow ref
    config.ts                 # Config persistence (v2 model config + app settings), Wayland detection,
                               #   hotkey registry
    conversations.ts          # Conversation persistence: CRUD on {userData}/conversations/{id}.json;
                               #   listConvs, loadMostRecentChat, KB-fed marking + auto-delete
    provider.ts               # Provider dispatch by role (callProvider + callProviderStream)
    models/
      registries.ts           # Re-export from src/shared/models.ts (keeps main import paths stable)
    lookup/
      lookup.ts               # Orchestrator: IPC wiring + handleHotkeyPressed entry point
      capture.ts              # Screen capture + OCR pipeline (tesseract.js worker)
      handlers.ts             # Paste-only handlers (Ask/Expand moved to shared streaming IPC)
      state.ts                # Per-window LookupSession interface + helpers
      window.ts               # Lookup popup BrowserWindow creation + grow animation
    services/
      global-shortcut.ts      # XDG GlobalShortcuts D-Bus routing (Wayland)
      screen-capture.ts       # Freedesktop Screenshot D-Bus routing (KDE Wayland)
  preload/
    index.ts                  # contextBridge API exposed to renderer (includes chat streaming channels)
    index.d.ts                # Type declarations for window.api & window.electron
  renderer/
    index.html                # Single-page shell (mounts #root); also serves lookup via ?role=lookup
    src/
      main.tsx                # ReactDOM.createRoot entry, imports base.css + lookup.css, mounts Root
      Root.tsx                # Routes between App and LookupApp based on window location query
      App.tsx                 # Shell: sidebar + 5-view routing + Conversation component
      LookupApp.tsx           # Lookup popup: header, OCR context panel, paste, Conversation,
                              #   transfer-to-chat button, keyboard shortcuts
      env.d.ts                # Vite env type shim
      assets/
        base.css              # CSS entry point: imports home.css, chat.css, settings.css, expand.css;
                              #   defines design tokens (:root), CSS reset, legacy aliases
        home.css              # App layout, sidebar (brand + nav + footer), view-shell
                              #   (shared header/content), KB canvas placeholder, responsive
        chat.css              # Chat view: toolbar with New-chat button, message list,
                              #   composer, loading dots, scrollbar
        expand.css            # Expansion frames, queried pills, frame-inner, fold-toggle,
                              #   custom context menu styles (shared by chat + lookup)
        lookup.css            # Lookup popup: header, context panel, ask input, conversation turn
                              #   overrides, scrollbar, transfer button, growth transitions
        settings.css          # Settings page: category tabs, forms, toggle switch, save button,
                              #   scrollbar
      views/
        home/
          HomeView.tsx        # Dashboard shell with KB canvas placeholder
        knowledge/
          KnowledgeView.tsx   # Empty-state stub for Knowledge Base (Coming soon)
        lookup-guide/
          LookupGuideView.tsx # Empty-state stub for Look-Up Guide (Coming soon)
        settings/
          Settings.tsx        # Settings orchestrator (3 tabs + save); owns modelConfig state
          GeneralTab.tsx      # General tab (hotkey + close-to-tray toggle)
      components/
        conversation/
          Conversation.tsx    # Shared conversation UI: message list, composer, context menu
                              #   handling, expansion anchoring with index-based selection
          Turn.tsx            # Single message turn with avatars, loading dots, segment rendering
          ExpansionFrame.tsx  # Inline expansion frames: folded pill vs. expanded frame with
                              #   child segments, fold button
          ContextMenu.tsx     # Custom right-click menu: Expand, Expand on…, Copy, Select All
          ExpandPrompt.tsx    # Floating inline input for "Expand on…" custom direction
          ConversationSearch.tsx # Modal overlay for searching + loading past conversations by title
        settings/
          HotkeyInput.tsx     # Hotkey capture input with keyboard combo rendering
          models/
            ModelsTab.tsx     # Models tab: Roles + Connections sections, add-connection
            RoleRow.tsx       # Single role row (connection selector, model field, web search)
            ConnectionCard.tsx# Single connection card (provider type, API key/host, base URL)
      hooks/
        useChatStreaming.ts   # Shared streaming hook: owns ConversationState, sends via
                              #   chat-send/chat-expand IPC, routes responses by requestId,
                              #   supports role ('chat'|'lookup'), context seed, replace-conversation
        useChatReplaceConversation.ts  # (inline in useChatStreaming) — listens for
                              #   chat-replace-conversation IPC to hydrate transferred state
```

## Data flow (layers)

```
Renderer (React 19) — App.tsx / LookupApp.tsx

 Shared channels (both windows, correlated by requestId):
   window.api.chatSend({ messages, requestId, role? })
   window.api.chatExpand({ messages, requestId, role? })
   + chatOnChunk / chatOnResponse / chatOnError / chatOnExpandChunk

  Lookup-only channels:
    window.api.lookupTriggerGrow()
    window.api.lookupTransferToChat(state, conversationId?)
    window.api.lookupOnContext(cb)
    window.api.lookupOnGrow(cb)
    window.api.lookupPasteText / lookupPasteImage / lookupOcrImage
    window.api.lookupInputChanged(hasText)
    window.api.lookupClose()

  Conversation persistence channels:
    window.api.saveConversation(record)
    window.api.loadConversation(id)
    window.api.deleteConversation(id)
    window.api.listConversations()
    window.api.loadMostRecentChat()
    window.api.listUnfedConversations()
    window.api.markConversationKbFed(id)

    ▼
Main process (Node)          src/main/
    ├── index.ts            App lifecycle + main window + streaming IPC handlers
    │                         (chat-send, chat-expand, lookup-trigger-grow, lookup-transfer)
    ├── main-window.ts      Module-scoped ref to main BrowserWindow (for transfer)
    ├── config.ts           Model config persistence, Wayland, hotkey
    ├── provider.ts         Role-based provider dispatch (callProvider/callProviderStream)
    ├── models/registries.ts  Re-export from src/shared/models.ts
    ├── lookup/
    │   ├── lookup.ts       Orchestrator: handleHotkeyPressed entry point
    │   ├── capture.ts      Screen capture + OCR (tesseract worker)
    │   ├── handlers.ts     Paste-only handlers (Ask/Expand moved to streaming IPC)
    │   ├── state.ts        Per-window LookupSession interface + helpers
    │   └── window.ts       Lookup popup window + grow animation (loads React entry via ?role=lookup)
    └── services/
        ├── global-shortcut.ts  XDG GlobalShortcuts D-Bus (Wayland)
        └── screen-capture.ts   Freedesktop Screenshot (KDE Wayland)
    ▼
Shared (pure types + helpers)  src/shared/
    ├── models.ts           ProviderType, RoleId, Connection, RoleAssignment, ModelConfig,
    │                          providerRegistry, roleRegistry, DEFAULT_ROLES, helpers
    ├── conversation.ts     ConversationState, Turn, ExpandableSegment types; pure helpers:
    │                          tokenize, flattenMarkdown, insertExpansion, serializeForChat,
    │                          findExpansionParent, updateExpansionInSegments, etc.
    ├── expand-prompt.ts    buildExpandMessages({ answer, selection, prompt? }) — constructs
    │                          API messages for expand requests (supports custom direction)
    └── prompts.ts           All LLM-facing prompt strings: system prompts, context template,
                             lookup default, expand default + prompted instructions
OS  (fs {userData}/config/, Google Gemini API / OpenAI-compatible endpoints,
      tesseract WASM, D-Bus portals, desktopCapturer)
```

## Main process architecture

The main process is split by concern across multiple files (not monolithic):

### `index.ts` — App lifecycle, main window, streaming handlers

**Window management:**

- `createWindow()` — creates main 960×640 BrowserWindow, loads renderer
- Exports nothing window-related itself; the main window ref is stored in `main-window.ts`

**IPC handlers:**

- `chat-send` (`ipcMain.on`) — streaming send. Calls `callProviderStream(messages, role)` with `role` from payload (default `'chat'`). Responds per-chunk via `event.sender.send('chat-chunk', { requestId, text })` and final via `chat-response` / `chat-error`. All responses scoped to the sending webContents (safe for both chat window and lookup popup to use the same channel).
- `chat-expand` (`ipcMain.on`) — streaming expand for inline frames. Same pattern as `chat-send`, responds via `chat-expand-chunk`.
- `lookup-trigger-grow` (`ipcMain.on`) — lookup popup asks main to grow the window on first ask. Finds the session by `event.sender.id`, calls `animateGrowSession` + `sendToSession(..., 'lookup-grow')`.
- `lookup-transfer` (`ipcMain.on`) — lookup popup sends `{ state: ConversationState, conversationId?: string }`. Transforms screen context into a user turn via `buildScreenContextMessage`, saves the conversation record with `source: 'chat'`, then sends `{ state, conversationId, conversationTitle }` on `chat-replace-conversation` to the main window. Closes the lookup session afterward.

**Conversation persistence handlers** (all `ipcMain.handle`):

- `conversation-save` / `conversation-load` / `conversation-delete` — CRUD for individual `{userData}/conversations/{id}.json` files
- `conversation-list` — returns `ConversationMeta[]` for all chat-source conversations, sorted by `updatedAt` desc
- `conversation-load-most-recent` — loads the most recently updated chat conversation (for startup auto-load)
- `conversation-list-unfed` — returns metadata for all conversations where `kbFed === false` (KB model integration point)
- `conversation-kb-fed` — marks a conversation as fed to the KB model; if `source === 'lookup'`, also deletes it from disk

**Lifecycle:**

- `app.whenReady()` → creates window, registers hotkey
- `app.on('will-quit')` → unregisters shortcuts
- `app.on('window-all-closed')` → quits (except macOS)
- `app.on('activate')` → recreates window (macOS)

### `main-window.ts` — Main window ref

Module-level `let mainWindow: BrowserWindow | null` with `setMainWindow(win)` and `getMainWindow()` — used by the `lookup-transfer` handler to reach the chat window.

### `provider.ts` — Role-based provider dispatch

- `callProvider(messages, roleId)` — non-streaming; resolves the role's connection+model via `resolveRole(roleId)` from `config.ts`, routes to backend. Throws `RoleUnassignedError` if the role has no connection assigned.
- `callProviderStream(messages, roleId)` — streaming variant; same resolution and error behaviour.
- `callOpenAICompatible(apiKey, model, messages, baseUrl, webSearchEnabled)` — unified OpenAI-compatible client
  - Google AI Studio calls this with `baseUrl` from the connection (default `https://generativelanguage.googleapis.com/v1beta`)
  - OpenAI Compatible provider uses user-specified `baseUrl` + `/chat/completions`
- `callGeminiWithSearch(apiKey, model, messages)` / `...Stream(...)` — Google search-grounded variant
- `NoApiKeyError`, `UnsupportedProviderError`, `RoleUnassignedError` — sentinel error classes
- Provider type switching is driven by `connection.providerType` (the provider registry enum). Unknown-but-registered types (e.g. Ollama, OpenAI, OpenRouter when not yet implemented) throw `UnsupportedProviderError`.

### `src/shared/models.ts` — Shared types and registries

Pure TypeScript module (no Node or React dependencies) importable by both the main process and the renderer. Declares:

- **Types:** `ProviderType`, `AuthShape`, `RoleId`, `Connection`, `RoleAssignment`, `ModelConfig`, `ProviderTypeDef`, `RoleDef`
- **`providerRegistry`** — per-provider-type definition: label, auth shape (`apiKey`/`host`/`none`), `defaultBaseUrl`, capability flags (`webSearch`), `implemented` flag, `knownModels` list
- **`roleRegistry`** — per-role definition: label, description, `locked` flag (KB roles are locked until KB feature ships), `offersWebSearch` flag
- **`DEFAULT_ROLES`** — default role assignments (all `connectionId: null`)
- **`createDefaultModelConfig()`**, **`generateConnectionId()`** — helpers used by both main (`config.ts`) and renderer (`ModelsTab.tsx`)

### `src/shared/conversation.ts` — Conversation model (new)

Shared model and pure helpers that drive both the chat and lookup UIs:

**Types:**

- `ConversationState { context?, systemNote?, turns: Turn[] }` — the portable conversation model
- `Turn { id, role, content, segments?, error? }` — a single message turn
- `ExpandableSegment` — a segment of an assistant answer:
  - `{ kind: 'text', text }` — plain word/whitespace
  - `{ kind: 'expansion', expansionId, originalText, cachedText, error?, loading?, folded, segments[] }` — an inline expansion frame with recursive child segments
- `ConversationRecord { id, title, createdAt, updatedAt, source, state, kbFed }` — persisted conversation with metadata
- `ConversationMeta { id, title, createdAt, updatedAt, source, kbFed, turnCount }` — lightweight metadata for search (excludes `state`)

**Pure helpers (no DOM, no React, no IPC):**

- `tokenize(text)` — flattens markdown, splits on whitespace, returns `ExpandableSegment[]`
- `flattenMarkdown(text)` — strips headings, bold/italic, inline code, links, list markers, blockquotes
- `insertExpansion(segments, startIndex, endIndex, selection, newExpansionId)` — replaces a word range with an expansion node; refuses if the range crosses an existing expansion boundary
- `updateExpansionInSegments(segments, id, patch)` — immutable update of an expansion node
- `updateExpansionInTurns(turns, id, patch)` — convenience for updating across all turns
- `toggleExpansionFoldedInSegments` / `toggleExpansionFoldedInTurns` — fold/unfold by flipping `folded` flag
- `findExpansionParent(segments, id)` — finds a parent expansion node (for nested expand context)
- `serializeForChat(state)` — produces `ProviderMessage[]` for the API call (context as system prompt, turns as user/assistant messages)
- `findTextSelectionRange` — helper for finding segment indices from a raw range

### `src/shared/expand-prompt.ts` — Expand prompt builder (new)

`buildExpandMessages({ answer, selection, prompt? })` — shared helper that builds the API messages
for an inline expansion request. When `prompt` is provided, uses `buildExpandPromptedInstruction`
(a user-customisable verb like "elaborate on"); otherwise uses `buildExpandUserInstruction`
("Define `{selection}` from the text above") with guardrails against restating the word.

### `src/shared/prompts.ts` — Unified prompts file (new)

All LLM-facing prompt/instruction strings are defined here, organised by section:

- **System prompts** — `LOOKUP_SYSTEM_PROMPT` and `CHAT_SYSTEM_PROMPT` with `getSystemPrompt(role)` selector
- **Context injection** — `buildScreenContextMessage(context)` wraps OCR text into a user message
- **Lookup defaults** — `LOOKUP_DEFAULT_QUERY` ("summarize") used when the user submits an empty ask
- **Expand instructions** — `buildExpandUserInstruction(selection)` for the default "Define..." expand;
  `buildExpandPromptedInstruction(selection, prompt)` for custom-direction expands;
  `EXPAND_DEFAULT_PROMPT` ("elaborate on") used when the prompt input is submitted empty

Constraints are split into shared (restating prohibition, concise output) and define-specific
(no "refers to", bare phrase, examples) so the prompted variant uses only the shared ones.

Pure module — no runtime deps. Imported by `expand-prompt.ts`, `conversation.ts`, and `useChatStreaming.ts`.

### `models/registries.ts` — Main-process re-export

Re-exports everything from `src/shared/models.ts` so main-process imports (`./models/registries`) keep working without reaching across the renderer boundary.

### `config.ts` — Configuration persistence and hotkey management

**Types (re-exported from `src/shared/models.ts`):**

```typescript
interface Connection {
  id: string
  label: string
  providerType: ProviderType
  apiKey?: string
  baseUrl?: string
  host?: string
}

interface RoleAssignment {
  connectionId: string | null
  model: string
  webSearchEnabled: boolean
}

interface ModelConfig {
  schemaVersion: number
  connections: Record<string, Connection>
  roles: Record<RoleId, RoleAssignment>
}

interface AppSettings {
  hotkey: string
  closeToTray: boolean
}
```

**Error classes:**

- `RoleUnassignedError` — thrown when a role has no connection assigned; message includes the role's display name

**Functions:**

- `ensureConfigDir()` — returns `{userData}/config/`, creates if missing
- `loadModelConfig()` — reads `providers.json` → `ModelConfig`; returns a fresh default if missing or corrupt
- `saveModelConfig(config)` — writes `providers.json`, returns `boolean`
- `resolveRole(roleId)` — returns `{ connection, model, webSearchEnabled }` for the given role, or `null` if unassigned
- `loadAppSettings()` — reads `settings.json` → `AppSettings` (default `{ hotkey: 'Ctrl+Shift+D', closeToTray: true }`)
- `saveAppSettings(settings)` — writes `settings.json`, returns `boolean`
- `registerHotkey(accelerator, onPressed)` — async; routes through XDG portal on Wayland

**IPC handlers:**

- `load-model-config` — returns full `ModelConfig` (connections + roles)
- `save-model-config` — writes entire `ModelConfig` at once
- `load-settings` — returns `AppSettings`
- `save-settings` — writes settings and re-registers hotkey

**Wayland detection:**

- `isWaylandSession()` — checks `XDG_SESSION_TYPE`, `WAYLAND_DISPLAY`, `ELECTRON_OZONE_PLATFORM_HINT`
- `isKdeWaylandSession()` — additionally checks `XDG_CURRENT_DESKTOP` for KDE

### Model configuration architecture

The app uses a **role-based model assignment** system. Instead of a single global provider, each job in the app (a "role") independently maps to a **provider connection** plus a **model id**.

**Roles** (`roleRegistry` in `src/shared/models.ts`):

| Role ID             | Label                      | Locked | Web search | Used by                                 |
| ------------------- | -------------------------- | ------ | ---------- | --------------------------------------- |
| `chat`              | Chat                       | No     | Yes        | `chat-send` IPC (main chat)             |
| `lookup`            | Lookup                     | No     | Yes        | `chat-send` IPC (lookup, role='lookup') |
| `kb-maintenance`    | Knowledge Base Maintenance | Yes    | No         | (planned: KB processing)                |
| `context-injection` | Context Injection          | Yes    | No         | (planned: KB → lookup injection)        |

Locked roles are shown greyed in Settings with a "🔒 Locked" indicator; their dispatch is not wired until the KB feature ships.

**Connections** are reusable provider credentials (API key / host + base URL). One connection can serve multiple roles with different models. Deleting a connection nulls out any role that referenced it.

**Provider types** (`providerRegistry`):

| Provider type       | Auth    | Default base URL                                   | Implemented     |
| ------------------- | ------- | -------------------------------------------------- | --------------- |
| `google-ai-studio`  | API key | `https://generativelanguage.googleapis.com/v1beta` | ✅              |
| `openai-compatible` | API key | (user-specified)                                   | ✅              |
| `openai`            | API key | `https://api.openai.com/v1`                        | ⛔ (selectable) |
| `ollama`            | Host    | (uses `host` field, e.g. `http://localhost:11434`) | ⛔ (selectable) |
| `openrouter`        | API key | `https://openrouter.ai/api/v1`                     | ⛔ (selectable) |

**Resolution flow:** Callers pass a `roleId` to `callProvider`/`callProviderStream`. The provider module calls `resolveRole(roleId)` from `config.ts`, which returns `{ connection, model, webSearchEnabled }` or `null`. On `null`, `RoleUnassignedError` is thrown with a role-specific message. The `webSearchEnabled` flag is read from the role assignment (not passed by callers), so callers no longer need to know about web search configuration.

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

**`handlers.ts` (simplified in this commit):**

- `handlePasteText(session, text)` — bumps session token, sets text as context, marks ready
- `handlePasteImage(session, base64)` — bumps session token, runs OCR on image via `runOCRTokenedFor`, marks ready
- (Removed: `handleLookupAsk`, `handleLookupExpand`, `initializeMessagesWithContext` — these now flow through the shared `chat-send`/`chat-expand` streaming IPC handlers in `index.ts`.)

**`state.ts`:**

- `LookupSession` — per-session mutable object: `window`, `context`, `grown`, `contextReady`, `ocrToken`, `hasText`
- `sendToSession(session, channel, ...args)` — safely sends IPC to a session's window
- `notifySessionState(session, status, text, hint)` — pushes `{ status, text, hint }` to a popup renderer
- `clamp(v, lo, hi)` — pure utility for window positioning
- `isSessionAlive(session)` — checks if a session's window is alive

**`window.ts` (updated):**

- `createLookupSession(x, y)` — 420×320 always-on-top frameless BrowserWindow near cursor. Registers per-window IPC handlers: `lookup-paste-text`, `lookup-paste-image`, `lookup-close`, `lookup-input-changed`. Blur closes only if not grown AND Ask field has no text. On `closed`, removes itself from the sessions list and decrements a ref-counted `lookup-ocr-image` handler.
- **No longer** registers `lookup-ask` or `lookup-expand` — those flow through the shared `chat-send`/`chat-expand` handlers.
- Loads the renderer via `loadURL(dev URL + '?role=lookup')` or `loadFile(..., { query: { role: 'lookup' } })` instead of the deleted `html.ts` data: URL.
- Ref-counted `lookup-ocr-image` handler (`ocrHandlerRefCount`): registered once across all sessions, removed when the last session closes.
- `animateGrowSession(session, w, h, targetX?, targetY?)` — easeOutCubic animation (unchanged).
- Exports `LOOKUP_GROWN_WIDTH` / `LOOKUP_GROWN_HEIGHT` for use by `index.ts` (the `lookup-trigger-grow` handler).

**`html.ts` — deleted (was 965 lines).** The lookup popup HTML/CSS/JS inline data: URL is replaced by the React `LookupApp` component in `src/renderer/src/LookupApp.tsx`. The expansion frame, context menu, paste, and keyboard logic moved to React components and shared model helpers.

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
  // Config
  loadModelConfig()          // Load full ModelConfig (connections + roles)
  saveModelConfig(config)    // Save full ModelConfig
  loadSettings()             // Load app settings (hotkey, closeToTray)
  saveSettings(settings)     // Save app settings

  // Lookup popup: main → renderer (one-way)
  lookupOnContext(cb)        // {status, text, hint} — OCR context state
  lookupOnError(cb)          // Error string
  lookupOnGrow(cb)           // (width, height) — grow animation signal

  // Lookup popup: renderer → main
  lookupPasteText(text)      // Pasted text as context
  lookupPasteImage(base64)   // Pasted image for OCR
  lookupOcrImage(base64)     // Invoke OCR on an image → {text, error?}
  lookupInputChanged(bool)   // Whether Ask field has text (guards blur-to-close)
  lookupClose()              // Close the popup
  lookupTriggerGrow()        // Ask main to animate window growth on first question
  lookupTransferToChat(state, conversationId?)
                             // Send ConversationState to main window; optionally ties it to an
                             // existing conversation record (for source:lookup → source:chat promotion)

  // Conversation persistence
  saveConversation(record)   // Persist a ConversationRecord to {userData}/conversations/{id}.json
  loadConversation(id)       // Load a single conversation record (returns null if missing)
  deleteConversation(id)     // Remove a conversation from disk (silent if missing)
  listConversations()        // List metadata for all chat-source conversations (sorted by updatedAt desc)
  loadMostRecentChat()       // Load the full record of the most recently updated chat conversation
  listUnfedConversations()   // KB prep: list all conversations where kbFed === false
  markConversationKbFed(id)  // KB prep: set kbFed = true; auto-deletes if source === 'lookup'

  // Chat streaming (correlated by requestId)
  chatSend({messages, requestId, role?})
  chatExpand({messages, requestId, role?})
  chatOnChunk(cb)            // {requestId, text} — returns unsub function
  chatOnResponse(cb)         // {requestId, text} — returns unsub function
  chatOnError(cb)            // {requestId, error} — returns unsub function
  chatOnExpandChunk(cb)      // {requestId, text?, error?, done?} — returns unsub function
  chatOnReplaceConversation(cb) // {state, conversationId, conversationTitle} — from lookup transfer
}
```

Key pattern: all chat streaming listeners return an `unsubscribe` function for proper cleanup on component unmount (unlike the lookup listeners which are always-on).

## Renderer (`src/renderer/src/`)

### `Root.tsx` — Entry point router (new)

Checks `window.location.search.includes('role=lookup')` to decide whether to render `LookupApp` (for the popup window) or `App` (for the main chat window). Both share the same renderer bundle.

### `App.tsx` — Application shell

**State:**

- `view: 'home' | 'chat' | 'knowledge' | 'lookup-guide' | 'settings'` — which view is showing (default `'home'`)
- `ConversationState` + streaming callbacks from `useChatStreaming()`, plus `conversationId` and `loadConversation`
- On mount, auto-loads the most recently updated chat conversation via `loadMostRecentChat` IPC

**Behavior:**

- Persistent sidebar with brand wordmark and 5 nav entries (Home, Chat, Knowledge Base, Look-Up Guide, Settings), rendered from a `navEntries` array with inline SVG icons
- Each entry switches `view` state; `.sidebar-nav-item.active` uses the dusty-blue accent fill
- Routes the active view into `.app-main`:
  - `home` → `<HomeView />`
  - `chat` → `<Conversation>` with streaming callbacks (`send`, `expand`, `fold`, `unfold`, `newChat`)
  - `knowledge` → `<KnowledgeView />`
  - `lookup-guide` → `<LookupGuideView />`
  - `settings` → `<Settings>`

### `LookupApp.tsx` — Lookup popup (new, replaces html.ts)

Reimplements the inline `html.ts` popup as a React component, reusing the conversation components:

**Layout:** Header bar ("Delta AI" + transfer button + close ✕), OCR context panel (`#extracted` with section-label), paste hint, ask input, hidden conversation area (revealed on grow).

**Lookup-specific behaviors (ported from html.ts vanilla JS):**

- **Context panel**: driven by `lookupOnContext` — shows OCR text, hints, flash animation.
- **Paste handling**: on non-grown state, paste replaces context (`lookupPasteText`). On grown state, paste inserts into the ask field (image→OCR via `lookupOcrImage`).
- **Grow**: first ask triggers `lookupTriggerGrow` which signals main to animate window growth. `lookupOnGrow` updates CSS height transitions and reveals the conversation area.
- **Escape** closes the popup; **Enter** submits the ask (guarded by `contextReady`); **Ctrl+V** is intercepted for paste-into-context (pre-grown) or OCR-into-ask (post-grown).
- **Transfer button**: "Send to chat" button in the header, enabled only when turns exist and no expansion is loading. Calls `lookupTransferToChat(state, conversationId)` to promote the lookup conversation to a chat conversation on disk.
- **Blur guard**: communicates `hasText` via `lookupInputChanged` (the main window's blur handler closes only when not grown + no text).

### `hooks/useChatStreaming.ts` — Shared streaming hook (updated)

Used by both `App.tsx` (role='chat') and `LookupApp.tsx` (role='lookup').

**Returns:** `{ state, loading, contextReady, conversationId, conversationTitle, send, expand, fold, unfold, newChat, loadConversation, setState }`

**Owns:**

- `ConversationState` in `useState` — the full conversation model (context, turns, expansions)
- `conversationId: string | null` — UUID of the current conversation (null until first send)
- `conversationTitle: string` — auto-extracted from first user message (flatten markdown, truncate 60 chars)
- `pendingRef` — a `Map<requestId, { kind, turnId, expansionId? }>` for correlating streaming responses
- `expansionIdCounterRef` — per-conversation counter for unique expansion IDs
- `conversationMetaRef` — ref mirroring id/title/createdAt for use inside stable effect closures
- `stateRef` — ref mirroring current `ConversationState` for use in `loadConversation`/`newChat` pre-save

**Lifecycle:**

`useEffect` subscribes to the `chatOn*` channels (returns cleanup unsubs). The subscribers dispatch by `requestId` to the correct pending request.

**Auto-save:** On every completed response (`chatOnResponse`), expand completion (`chatOnExpandChunk.done`), fold, and unfold, the hook persists the full `ConversationRecord` to disk via `window.api.saveConversation`. The record's `createdAt` is set once on first send; `updatedAt` updates on every save. Empty conversations (no turns or all-blank) are not saved.

**`send(content)`:** On first send, generates a UUID via `crypto.randomUUID()`, extracts a title from the user message, and stores it in `conversationMetaRef`. Then follows the existing send flow.

**`expand(...)`:** Same as before; auto-save is handled by `chatOnExpandChunk`'s `done` listener.

**`fold(id)` / `unfold(id)`:** Toggles the collapsed state and auto-saves.

**`newChat()`:** Saves the current conversation (if non-empty), resets conversationId/title/meta, clears state.

**`loadConversation(id)`:** Saves the current conversation (if non-empty), loads the target record from disk via IPC, sets conversationId/title/state, resets the expansion counter past the max imported id.

**Transfer listener:** `chatOnReplaceConversation` now receives `{ state, conversationId, conversationTitle }` — the main process already transformed lookup context into a user turn and persisted the record. The hook sets state directly, updates conversationId/title, and resets the expansion counter.

### `components/conversation/Conversation.tsx` — Shared conversation (new)

Renders the message list + composer + context menu. Key design decisions:

- **Right-click → anchor**: the `contextmenu` handler computes a segment-index anchor at event time, snapshots it locally, and closes over it. No `Range` objects stored in React state — only `(startIndex, endIndex)` indices, which survive re-renders and are the transfer-safe representation.
- **Single-word path**: `caretRangeFromPoint` detects the `.word` span under cursor, maps it to a segment index via DOM query.
- **Multi-word path**: iterates segments to find the text-boundary range.
- **Cross-frame guard**: `findExpansionInSegments`/`findTextSelectionRange` ensure Expand is disabled when the selection crosses an expansion boundary.
- **Composer**: identical to the old `ChatView`'s (textarea + send button + Enter/Shift+Enter).
- **Props**: `state`, `loading`, `onSend`, `onNewChat`, `onExpand`, `onFold`, `onUnfold`, `onLoadConversation?`, `conversationId?`, `transferKey?`
- **Toolbar**: "New chat" button + "Search" button (magnifying glass icon) that opens the `ConversationSearch` modal overlay. Only rendered when `hideToolbar` is falsy.
- **Scroll behavior**: Auto-scrolls to bottom when new chunks arrive (if user is near bottom), on `transferKey` change (lookup transfer), and on `conversationId` change (search/load conversation switch).

### `components/conversation/Turn.tsx` — Single turn (new)

Renders a user or assistant message. For assistant turns with `segments`, renders an `<InlineSegments>` tree. For plain text (during streaming), renders the `content` string directly. Handles loading dots for the in-progress turn.

### `components/conversation/ExpansionFrame.tsx` — Inline expansion frames (new)

Port of `html.ts`'s frame/pill system:

- **Folded state**: renders a `.queried` pill with `originalText`; clicking calls `onUnfold`.
- **Expanded state**: renders a `.frame.expanded` with `.frame-inner` containing either plain "Thinking…" (loading, no `cachedText`), tokenized child segments, or the resolved `cachedText` via `tokenizeInline`. Includes a `.fold-toggle` button that calls `onFold`.
- **Context menu**: propagation stops at `.frame` boundaries so the right-click context menu scopes to the correct turn.
- **`InlineSegments` sub-component**: iterates `ExpandableSegment[]` — text segments get `.word` spans, expansion segments get `<ExpansionFrame>`.

### `components/conversation/ContextMenu.tsx` — Custom context menu (new)

Renders `#ctxMenu` with Expand, Expand on…, Copy, Select All. Hides on click-outside or
Escape. Expand action calls the snapshot-closed-over `onExpand` callback.
"Expand on…" calls `onExpandPrompted` which opens the `ExpandPrompt` input.
Copy restores the cached range before `execCommand('copy')`.

### `components/conversation/ExpandPrompt.tsx` — Custom expand direction input (new)

Floating `<input>` at the right-click position, auto-focused on mount. Submits on Enter
(empty → "elaborate on"), closes on Escape or click-outside. The submitted value flows
through `useChatStreaming.expand(prompt?)` → `buildExpandPromptedInstruction`.

### `views/home/HomeView.tsx` — Home dashboard

- Brand header "Delta AI"
- Empty KB canvas placeholder (`<div class="kb-canvas">`) — unchanged.

### `views/chat/ChatView.tsx` — Deleted

Replaced by `Conversation.tsx` which renders into the app's chat view with the same toolbar/composer layout but with segment rendering, expand, and streaming.

### `views/knowledge/KnowledgeView.tsx` — Knowledge Base placeholder

- Empty-state stub with "Coming soon." (unchanged)

### `views/lookup-guide/LookupGuideView.tsx` — Look-Up Guide placeholder

- Empty-state stub with "Coming soon." (unchanged)

### `views/settings/Settings.tsx` — Settings orchestrator (unchanged)

**State:** `modelConfig` (full `ModelConfig`), `hotkey`, `closeToTray`, save state, active tab

**Behavior:**

- **Three tabs** (with fade animation on switch):
  - **General** — Renders `<GeneralTab>` (hotkey input + close-to-tray toggle)
  - **Models** — Renders `<ModelsTab>` (roles + connections)
  - **About** — Inline blurb
- Owns `modelConfig` state and mutation helpers; passes them down to `<ModelsTab>` as callbacks
- `handleSave()` — saves full `ModelConfig` + app settings

### `components/settings/models/ModelsTab.tsx`, `RoleRow.tsx`, `ConnectionCard.tsx`, `HotkeyInput.tsx` (unchanged)

### CSS architecture

**`base.css`** is the single CSS entry point (imported by `main.tsx`). It uses `@import` to load all sub-stylesheets, then declares the design token `:root` block and the CSS reset:

```
base.css  (imported by main.tsx)
  ├── @import 'home.css'        →  App layout, sidebar, view-shell, KB canvas, responsive
  ├── @import 'chat.css'        →  Chat toolbar, message list, avatar, composer, loading dots
  ├── @import 'settings.css'    →  Settings page, category tabs, form inputs, toggle, save button
  └── @import 'expand.css'      →  Expansion frames, queried pills, frame-inner, fold-toggle,
                                    custom context menu (shared by chat + lookup)
```

**`lookup.css`** is imported alongside `base.css` by `main.tsx`. It contains:

- Design token `:root` block (mirrors the base.css tokens for the popup window which loads without main app CSS scoping)
- Lookup layout (`.lookup`, `.lookup-header`, `.lookup-content`, `.lookup-conversation`)
- Context box (`.extracted`, `.section-label`, `.paste-tip`, `.ocr-hint`)
- Ask input (`.ask`, `.ask-wrap`)
- Turn style overrides for the lookup popup (`.lookup .message-*`)
- Transfer button styles (`.lookup-transfer-btn`)
- Scrollbar styles

**`expand.css`** contains all shared expansion frame and context menu CSS:

- `.word`, `.frame.expanded`, `.frame.loading`, `.frame.error`, `.frame-inner`, `.fold-toggle`, `.queried`
- `#ctxMenu` with `.item`, `.disabled`, `.sep`
- `#expandPrompt` with `.expand-prompt-input` — the floating custom-expand-direction input

Design tokens are declared as CSS custom properties in `:root` inside `base.css` and duplicated in `lookup.css`:

| Category | Tokens (examples)                                               |
| -------- | --------------------------------------------------------------- |
| Surfaces | `--bg`, `--surface-1`, `--surface-2`, `--surface-3`             |
| Borders  | `--border`, `--border-strong`                                   |
| Text     | `--text-1`, `--text-2`, `--text-3`, `--text-muted`              |
| Accent   | `--accent`, `--accent-strong`, `--accent-soft`, `--accent-ring` |
| Semantic | `--success`, `--error`                                          |
| Shape    | `--radius-sm`, `--radius-md`, `--radius-lg`                     |
| Shadows  | `--shadow-1`, `--shadow-2`                                      |

Legacy variables (`--ev-c-*`, `--chat-*`, `--color-*`) are aliased to the new tokens in `base.css` for backward compatibility during the transition.

## Configuration file format

**`{userData}/config/providers.json` (v2 schema):**

```json
{
  "schemaVersion": 2,
  "connections": {
    "conn_1721568938473_a1b2": {
      "id": "conn_1721568938473_a1b2",
      "label": "My Google key",
      "providerType": "google-ai-studio",
      "apiKey": "AIza…",
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta"
    },
    "conn_1721568950123_c4d5": {
      "id": "conn_1721568950123_c4d5",
      "label": "Local Ollama",
      "providerType": "ollama",
      "host": "http://localhost:11434"
    }
  },
  "roles": {
    "chat": {
      "connectionId": "conn_1721568938473_a1b2",
      "model": "gemini-3.5-flash",
      "webSearchEnabled": false
    },
    "lookup": {
      "connectionId": "conn_1721568938473_a1b2",
      "model": "gemini-3.5-flash",
      "webSearchEnabled": true
    },
    "kb-maintenance": { "connectionId": null, "model": "", "webSearchEnabled": false },
    "context-injection": { "connectionId": null, "model": "", "webSearchEnabled": false }
  }
}
```

**`{userData}/config/settings.json`:**

```json
{
  "hotkey": "Ctrl+Shift+D",
  "closeToTray": true
}
```

## Build pipeline (`electron-vite`)

```
electron.vite.config.ts
  ├── main    → out/main/index.js    (SSR, cjs)
  ├── preload → out/preload/index.js (SSR, cjs)
  └── renderer→ out/renderer/        (client, esm + HTML + CSS)
                                  (lookup popup loads the same bundle with ?role=lookup)
```

`npm run build` runs `typecheck:node` + `typecheck:web` (both `tsc --noEmit`), then `electron-vite build`.

## Platform-specific behavior

| Platform              | Hotkey registration         | Screen capture                 |
| --------------------- | --------------------------- | ------------------------------ |
| X11 / macOS / Windows | `globalShortcut.register()` | `desktopCapturer.getSources()` |
| KDE Plasma Wayland    | XDG GlobalShortcuts portal  | Screenshot portal (silent)     |
| GNOME / Other Wayland | XDG GlobalShortcuts portal  | `desktopCapturer.getSources()` |

## Major changes (2026-07-23 — conversation persistence + search)

Conversations are now persisted to `{userData}/conversations/{id}.json` and survive app restarts. Key impacts:

- **Persistence module** (`src/main/conversations.ts`): CRUD operations for `ConversationRecord` JSON files, with helpers for listing by source, loading the most recent chat, and KB model integration hooks (`markConversationKbFed`, `listUnfedConversations`).
- **New IPC handlers**: 7 invoke channels for conversation CRUD (`conversation-save`, `-load`, `-delete`, `-list`, `-load-most-recent`, `-list-unfed`, `-kb-fed`) registered in `index.ts`.
- **Auto-save**: `useChatStreaming` now saves on every completed response, expand completion, fold, and unfold. Title is auto-extracted from the first user message.
- **`lookup-transfer` overhaul**: The main process handler now transforms screen context into a formatted user turn via `buildScreenContextMessage`, persists the conversation as `source: 'chat'`, and passes `{state, conversationId, conversationTitle}` on `chat-replace-conversation`. The renderer hook no longer prepends context — the main process handles it.
- **Conversation search**: A "Search" button next to "New chat" opens a modal overlay (`ConversationSearch.tsx`) that performs client-side filtering by title. Keyboard-navigable with real-time results.
- **Startup auto-load**: `App.tsx` loads the most recently updated chat conversation on mount via `loadMostRecentChat` IPC.
- **KB prep channels**: `conversation-list-unfed` and `conversation-kb-fed` IPC channels exist for future KB maintenance model consumption. The `kb-fed` handler auto-deletes lookup-source conversations after marking.

## Major changes (2026-07-22 — streaming conversation + React lookup)

The last commit replaced the lookup's inline `data:text/html` popup (965 lines of vanilla JS/CSS/html) with a React component (`LookupApp.tsx`) that reuses the chat's conversation components. Key architectural impacts:

- **Unified conversation model**: `src/shared/conversation.ts` defines `ConversationState`, `Turn`, `ExpandableSegment` — a portable, DOM-range-free data model that both the chat and lookup windows operate on.
- **Shared streaming IPC**: the old one-shot `send-message` handler was replaced by `chat-send` + `chat-expand` (both streaming, both `event.sender`-scoped, both passing an optional `role` discriminator). The `useChatStreaming` hook subscribes to the same channel family from either window.
- **Ask/Expand moved from lookup handlers to shared IPC**: `handleLookupAsk` and `handleLookupExpand` in `handlers.ts` were deleted. Main handles send/expand through `index.ts` via the same `callProviderStream`, using `role: 'lookup'` for the lookup roleId. The grow-on-first-ask side effect was moved to a `lookup-trigger-grow` handler.
- **Expand UI shared**: `ExpansionFrame.tsx`, `Turn.tsx`, `ContextMenu.tsx`, and `Conversation.tsx` render the same expandable segment tree for both chat and lookup. The CSS lives in `expand.css` (shared).
- **Transfer**: the lookup popup has a "Send to chat" button that marshals its `ConversationState` to the main window via `lookup-transfer` IPC. The chat window's hook hydrates it and resets the expansion counter.

## Current feature status

| Feature                                          | Status                        |
| ------------------------------------------------ | ----------------------------- |
| Chat UI (chat view + send)                       | ✅ Complete (streaming)       |
| Settings with 3 tabs (General/Models/About)      | ✅ Complete                   |
| Role-based model config (chat, lookup, KB roles) | ✅ Complete (KB roles locked) |
| Provider connections (CRUD, per-role model)      | ✅ Complete                   |
| Google AI Studio provider                        | ✅ Complete                   |
| OpenAI Compatible provider                       | ✅ Complete                   |
| OpenAI / Ollama / OpenRouter providers           | ✅ Complete                   |
| Shared types/registry module                     | ✅ Complete                   |
| Shared conversation model with expandable tree   | ✅ Complete                   |
| OCR from screen (full capture)                   | ✅ Complete                   |
| AI explanation popup (React, streaming)          | ✅ Complete                   |
| Inline expandable frames (fold/unfold/nested)    | ✅ Complete                   |
| lookup→chat transfer                             | ✅ Complete                   |
| Conversation persistence (save/load/search)      | ✅ Complete                   |
| Global hotkey (X11 + Wayland)                    | ✅ Complete                   |
| Infinite recursive lookup                        | ✅ Complete                   |
| Home dashboard (KB canvas)                       | ✅ Complete                   |
| Knowledge Base                                   | ❌ Not started                |
| Built-in local model                             | ❌ Not started                |
| Look-Up Guide view                               | ❌ Not started                |
