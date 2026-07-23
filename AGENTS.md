# Delta AI

Electron desktop app (BYOK) with a ChatGPT-like chat UI (React 19) and an
always-on-top lookup popup that performs OCR on screen captures via global hotkey.
Targets Linux (X11 + KDE Wayland first-class), macOS/Windows secondary.

## Commands

- `npm run dev` — Launch app with HMR (electron-vite)
- `npm run typecheck` — `tsc --noEmit` (node: `src/main/**`, `src/preload/**`; web: `src/renderer/src/**`)
- `npm run lint` — ESLint + Prettier
- `npm run build` — Typecheck then `electron-vite build`
- `npm run format` — Prettier write across the repo

**Always run `npm run typecheck && npm run lint` after changing `.ts`/`.tsx`.**
The build will fail on typecheck errors, so fix them before committing.

## Critical rules

- Don't import Electron main APIs into the renderer; use the preload bridge.
- Don't bypass `registerHotkey` for global shortcuts — the portal path won't fire on Wayland.
- Don't commit secrets. API keys live only in `{userData}/config/providers.json`.
- When architecture changes, update this file.

## Detailed guidelines

### Architecture & Module Map

#### High-level call chain

```
Renderer (React 19) → Preload (contextBridge) → Main process (Node)
├── App.tsx / LookupApp.tsx ├── index.ts Streaming IPC (chat-send/chat-expand)
├── useChatStreaming hook │ + lookup-trigger-grow, lookup-transfer
├── Conversation/Turn/ExpansionFrame components ├── provider.ts AI dispatch (callProviderStream)
└── window.api.chatSend / chatExpand / lookup* ├── config.ts Persistence, hotkey, Wayland
├── lookup/ OCR → popup
└── services/ Wayland D-Bus portals
```

#### IPC channels

| Channel                                   | Direction       | Purpose                                                                       |
| ----------------------------------------- | --------------- | ----------------------------------------------------------------------------- |
| `chat-send`                               | Renderer → Main | Send a streaming chat message (role payload discriminates 'chat' vs 'lookup') |
| `chat-chunk`                              | Main → Renderer | Streaming chunk for a chat-send request (keyed by `requestId`)                |
| `chat-response`                           | Main → Renderer | Final response for a chat-send                                                |
| `chat-error`                              | Main → Renderer | Error for a chat-send                                                         |
| `chat-expand`                             | Renderer → Main | Request an inline word-expansion stream                                       |
| `chat-expand-chunk`                       | Main → Renderer | Streaming chunks for an expand request (keyed by `requestId`)                 |
| `chat-replace-conversation`               | Main → Renderer | Hydrate a transferred ConversationState into the chat window                  |
| `lookup-trigger-grow`                     | Lookup → Main   | On first ask, signal main to animate window growth                            |
| `lookup-transfer`                         | Lookup → Main   | Send ConversationState to chat, close lookup                                  |
| `lookup-context`                          | Main → Lookup   | OCR context state (`{status, text, hint}`)                                    |
| `lookup-grow`                             | Main → Lookup   | (`width, height`) signal grow animation on the renderer side                  |
| `lookup-paste-text`                       | Lookup → Main   | Pasted text replaces OCR context                                              |
| `lookup-paste-image`                      | Lookup → Main   | Pasted image → OCR → context                                                  |
| `lookup-ocr-image`                        | Lookup → Main   | Invoke OCR on an image (returns `{text, error?}`)                             |
| `lookup-input-changed`                    | Lookup → Main   | Whether Ask field has text (guards blur-to-close)                             |
| `lookup-close`                            | Lookup → Main   | Close the lookup window                                                       |
| `load-model-config` / `save-model-config` | Renderer ↔ Main | Model config CRUD                                                             |
| `load-settings` / `save-settings`         | Renderer ↔ Main | App settings CRUD                                                             |

#### Module map

##### Shared (`src/shared/`)

| Module             | Role                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `models.ts`        | Shared types + registries (ProviderType, RoleId, Connection, etc.)                                                  |
| `conversation.ts`  | ConversationState, Turn, ExpandableSegment types + pure helpers (tokenize, insertExpansion, serializeForChat, etc.) |
| `expand-prompt.ts` | `buildExpandMessages({answer, selection})` — constructs API messages for expand requests                            |

##### Main process (`src/main/`)

| Module              | Path                          | Role                                                                                                     |
| ------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| App lifecycle       | `index.ts`                    | Main window, tray, streaming IPC handlers (chat-send, chat-expand, lookup-trigger-grow, lookup-transfer) |
| Main window ref     | `main-window.ts`              | Module-scoped getter/setter for BrowserWindow ref (used by transfer handler)                             |
| Config              | `config.ts`                   | Persistence, hotkey registry, Wayland detection                                                          |
| Provider dispatch   | `provider.ts`                 | `callProvider` + `callProviderStream` (resolves role → connection → backend)                             |
| Lookup orchestrator | `lookup/lookup.ts`            | Hotkey entry point (capture + OCR + create popup)                                                        |
| Lookup popup window | `lookup/window.ts`            | BrowserWindow + grow animation + ref-counted ocr-image handler                                           |
| Capture + OCR       | `lookup/capture.ts`           | Screen capture + tesseract.js worker                                                                     |
| Handlers            | `lookup/handlers.ts`          | Paste-text and paste-image handlers only (Ask/Expand moved to streaming IPC)                             |
| Session state       | `lookup/state.ts`             | LookupSession interface + helpers (sendToSession, notifySessionState, isSessionAlive)                    |
| Wayland shortcut    | `services/global-shortcut.ts` | XDG GlobalShortcuts portal                                                                               |
| KDE screenshot      | `services/screen-capture.ts`  | Screenshot portal (silent)                                                                               |

##### Renderer (`src/renderer/src/`)

| Module         | Path                                                     | Role                                                                         |
| -------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Entry point    | `main.tsx`                                               | createRoot, imports CSS, mounts Root                                         |
| Root router    | `Root.tsx`                                               | Routes App (main window) vs LookupApp (popup) by `?role=lookup`              |
| App shell      | `App.tsx`                                                | Sidebar + 5-view routing                                                     |
| Lookup popup   | `LookupApp.tsx`                                          | Header, context panel, ask input, paste handling, grow transitions           |
| Chat hook      | `hooks/useChatStreaming.ts`                              | Owns ConversationState, sends via chat-send/chat-expand, routes by requestId |
| Conversation   | `components/conversation/Conversation.tsx`               | Message list + composer + context menu                                       |
| Turn           | `components/conversation/Turn.tsx`                       | Single message (user/assistant) with avatars, segments, loading              |
| ExpansionFrame | `components/conversation/ExpansionFrame.tsx`             | Inline expandable frames, folded pills, nested children                      |
| ContextMenu    | `components/conversation/ContextMenu.tsx`                | Right-click Expand/Copy/Select All                                           |
| Settings       | `views/settings/Settings.tsx`                            | 3-tab settings orchestrator                                                  |
| Views          | `views/home/`, `views/knowledge/`, `views/lookup-guide/` | Dashboard and placeholder views                                              |

#### What to touch when

| Task                                  | File(s)                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| Add an AI provider                    | `provider.ts` (`callProvider` switch)                                              |
| Change the OCR/capture pipeline       | `lookup/capture.ts`                                                                |
| Change the hotkey response flow       | `lookup/lookup.ts` (`handleHotkeyPressed`)                                         |
| Reposition / restyle the lookup popup | `lookup/window.ts` + CSS in `lookup.css`, `LookupApp.tsx`                          |
| Change the expand prompt              | `shared/expand-prompt.ts` (`buildExpandMessages`)                                  |
| Change frame fold/unfold behaviour    | `shared/conversation.ts` helpers + `ExpansionFrame.tsx`                            |
| Change the expansion targeting logic  | `Conversation.tsx` (contextmenu handler) + `shared/conversation.ts` helpers        |
| Persist or load user config/settings  | `config.ts`                                                                        |
| Wayland global-shortcut binding       | `services/global-shortcut.ts`                                                      |
| KDE Wayland silent screenshot         | `services/screen-capture.ts`                                                       |
| Add a new IPC channel                 | preload `index.ts` + `.d.ts`, then main `index.ts`                                 |
| Change the chat streaming hook        | `hooks/useChatStreaming.ts`                                                        |
| Renderer chat UI                      | `App.tsx`, `Conversation.tsx`, `Turn.tsx`                                          |
| Provider config form                  | `components/settings/models/ModelsTab.tsx` (+ `RoleRow.tsx`, `ConnectionCard.tsx`) |

#### Important conventions

- **Provider dispatch lives in `provider.ts`.** `callProviderStream(messages, roleId)` reads the
  config and selects the backend; everyone else (streaming IPC handlers, lookup) calls it via
  the roleId. Don't duplicate `resolveRole()` + provider branching elsewhere.
- **The lookup popup is a 420×320 always-on-top frameless `BrowserWindow`** created in
  `lookup/window.ts` via `createLookupSession`. It loads the **same renderer bundle** as the
  main window, with `?role=lookup` query param (see `Root.tsx`). Position is best-effort near
  cursor; compositor may centre on Wayland (acceptable). On first ask, grows to 840×640 via
  `animateGrowSession` + `lookup-trigger-grow` IPC.
- **There can be multiple lookup sessions.** The global `lookupSessions` array in `state.ts`
  owns `LookupSession` objects, each holding its window ref, OCR context text, OCR token,
  `grown`, `contextReady`, and `hasText`. Use `isSessionAlive` / `sendToSession` /
  `notifySessionState` rather than touching window refs directly.
- **Lookup blur behaviour:** a window closes on blur only when the user has never focused it,
  is not grown, and the Ask field is empty (`!session.hasText`). Once grown, the window stays
  open on blur so the user can keep consulting it while triggering new lookups.
- **OCR captures the full screen**, not a cropped region. `captureScreen()` grabs the entire
  display; `runOCR()` processes the whole image. Cursor position may return `(0,0)` on
  Wayland, but full-screen capture + full-image OCR keeps the feature working regardless.
- **Portal code is KDE/Wayland-specific by design.** `isScreenCapturePortalPreferred()` and
  `isKdeWaylandSession()` gate it. Keep `desktopCapturer` as default for
  X11/macOS/Windows and non-KDE Wayland.
- **Config files** live under `{userData}/config/` (`providers.json`, `settings.json`).
  Always go through `config.ts` helpers; call `ensureConfigDir()` before writing.
- **Hotkey registry** is in `config.ts:registerHotkey`. It auto-routes through the XDG
  portal on Wayland. When `save-settings` changes the hotkey, it re-registers by calling
  `registerHotkey` with `handleHotkeyPressed` — keep that callback wiring intact.
- **`path` vs `path/posix`**: `config.ts` and `index.ts` use `path`,
  `lookup/capture.ts` and `lookup/window.ts` use `path/posix`. The tesseract cache path
  uses `path/posix` deliberately — match the existing import in the file you're editing.
- **Tray support**: `index.ts` creates a `Tray` with context menu (Show/Quit).
  `config.ts:currentCloseToTray` controls whether closing the main window hides to tray
  instead of quitting. The `close` handler in `createWindow` checks
  `currentCloseToTray && !isQuitting`.
- **Shared streaming IPC (`chat-send`/`chat-expand`)** responds via `event.sender.send()`.
  All responses are scoped to the sending webContents — safe for both windows to use the
  same channel family. The `role` payload field routes to the correct roleId
  (`'chat'` or `'lookup'`) for `callProviderStream`.
- **Expand data model is model-first, not DOM-first.** Expansion operations (insert, fold,
  unfold, update) happen on the `ExpandableSegment[]` tree in `ConversationState`, not on
  live DOM. The `ExpansionFrame` React component re-renders from the pure data. No
  `expansionCache` with detached frame elements — the segment tree IS the cache.
- **Transfer (lookup → chat) marshals the full `ConversationState`** via
  `lookup-transfer` IPC. The chat hook hydrates it into its `useState`, resets the
  `expansionIdCounter` past the max imported id. No DOM serialization needed.
- **Inline expansions use index-based anchoring, not live DOM Range.** Right-click
  computes `(startIndex, endIndex)` against the `ExpandableSegment[]` at event time,
  snapshots the indices, and closes over them. No `Range` objects survive into React state.
- **Cross-frame selection disables Expand.** The contextmenu handler in
  `Conversation.tsx` uses `findExpansionInSegments` to detect whether a selection spans
  an expansion boundary; `insertExpansion` in `conversation.ts` also refuses cross-frame.

### Coding Style Guidelines

These rules apply to all `.ts` and `.tsx` files. Linting and formatting are enforced
by ESLint + Prettier — the rules below document patterns that lint can't catch.

#### Prettier (enforced by `.prettierrc.yaml`)

- Single quotes
- No semicolons
- `printWidth: 100`
- `trailingComma: none`

#### TypeScript

- Prefer explicit types on **exported function signatures** and on union/string-literal return
  types. Let locals be inferred where obvious.
- **No `eslint-disable` unless truly warranted.** The repo already disables
  `@typescript-eslint/no-explicit-any` on one line (the tesseract.js worker) — that's a
  pattern to copy if a third-party API is untyped, rather than scattering `any` around.
- Use `import type` for type-only imports. See `lookup/handlers.ts:1` importing
  `LookupSession` from `./state`, or `index.ts:14` importing `ProviderMessage` from
  `./provider` for the pattern.

#### Comments

- **Sparse, purposeful.** Do not add comments that restate the code.
- Use `/* ---- Section ---- */` dividers in main-process files (see `index.ts`, `config.ts`).
- JSDoc only where the function's contract is non-obvious or for IPC handler documentation
  (see `lookup/handlers.ts` `handleLookupAsk`/`handleLookupExpand` — though those were
  deleted, their doc style is the template).

#### Function ordering (C-style)

In any file containing multiple functions or blocks, order them so that **callees appear
before callers**. When a caller invokes multiple callees in sequence, order those parallel
callees in a **logical and sequential** order.

#### Imports

- Named imports (not `import *`).
- Grouped loosely by source: Node builtins first, then npm packages, then project modules.
- Use `import type` for type-only imports (see above).

#### Error handling

- Main-process async functions return cleanly structured error information to the renderer.
  Examples:
- `{ success, error }` from IPC handlers
- Sentinel error classes: `NoApiKeyError`, `UnsupportedProviderError`,
  `RoleUnassignedError` for provider dispatch
- Don't `console.log` errors that the user should see; surface them to a window.
- IPC payloads use `Array<{ role: string; content: string }` and
  `{ success: boolean; response?: string; error?: string }` — mirror these in both the
  preload (`index.ts`/`index.d.ts`) and the renderer.

#### React (renderer)

- File extension `.tsx`. Components are function components returning `React.JSX.Element`
  (see `App.tsx`). No prop types file — inline `type` aliases.
- Styling is plain CSS in `assets/`, using the `:root` CSS variables documented in
  `docs/architecture.md`. Do not introduce CSS-in-JS or Tailwind without discussion.
- Keep the renderer thin: it talks only to `window.api`. Privileged work belongs in the
  main process.
