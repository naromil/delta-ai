# Delta AI

Electron desktop app (BYOK) with a ChatGPT-like chat UI (React 19) and an
always-on-top lookup popup that performs OCR on screen captures via global hotkey.
Targets Linux (X11 + KDE Wayland first-class), macOS/Windows secondary.

## Commands

- `npm run dev` — Launch app with HMR (electron-vite)
- `npm run typecheck` — `tsc --noEmit` (node: `src/main/**`, `src/preload/**`; web: `src/renderer/src/**`)
- `npm run lint` — ESLint (Prettier-compatible config; `format:check` verifies formatting)
- `npm run test` — Vitest over `tests/**` (unit tests + acceptance gates)
- `npm run verify` — typecheck + lint + test + `prettier --check`
- `npm run build` — Typecheck then `electron-vite build`
- `npm run format` — Prettier write across the repo

**Always run `npm run typecheck && npm run lint` after changing `.ts`/`.tsx`.**
The build will fail on typecheck errors, so fix them before committing.

## Critical rules

- Don't import Electron main APIs into the renderer; use the preload bridge.
- Don't bypass `registerHotkey` for global shortcuts — the portal path won't fire on Wayland.
- Don't commit secrets. API keys live only in `{userData}/config/providers.json`.
- No native (node-gyp) addons in the main process. Electron 39 runs a V8 sandbox, so any addon built
  against the host Node ABI aborts the process on first use (`v8_ArrayBuffer_NewBackingStore` →
  SIGSEGV → a multi-GB systemd-coredump that fills the disk). `dbus-next`'s optional `usocket` is
  pruned by `scripts/strip-usocket.mjs` in `postinstall` for exactly this reason; if a dependency
  needs native code, rebuild it for Electron or pick a pure-JS alternative.
- Use custom scrollbars everywhere — never the native OS scrollbar. Style `::-webkit-scrollbar` on scrollable elements.
- Store all AI-facing prompt strings as exported constants in `src/shared/prompts.ts`. Never inline a prompt in a handler or component.
- When architecture changes, update this file.

## Detailed guidelines

### Architecture & Module Map

#### High-level call chain

```
Renderer (React 19) → Preload (contextBridge) → Main process (Node)
├── App.tsx / LookupApp.tsx ├── index.ts Streaming IPC (chat-send/chat-expand/chat-cancel)
├── useChatStreaming hook │ + lookup-trigger-grow, lookup-transfer
├── Conversation/Turn/Markdown/ExpansionFrame  ├── provider.ts AI dispatch (callProviderStream)
└── window.api.chatSend / chatExpand / lookup* ├── config.ts Persistence, hotkey, Wayland
├── lookup/ OCR → popup
└── services/ Wayland D-Bus portals
```

#### IPC channels

| Channel                                   | Direction       | Purpose                                                                                      |
| ----------------------------------------- | --------------- | -------------------------------------------------------------------------------------------- |
| `chat-send`                               | Renderer → Main | Send a streaming chat message (role payload discriminates 'chat' vs 'lookup')                |
| `chat-chunk`                              | Main → Renderer | Streaming chunk for a chat-send request (keyed by `requestId`)                               |
| `chat-response`                           | Main → Renderer | Final response for a chat-send (`cancelled: true` + partial text after stop)                 |
| `chat-error`                              | Main → Renderer | Error for a chat-send                                                                        |
| `chat-cancel`                             | Renderer → Main | Abort an in-flight `chat-send`/`chat-expand` by `requestId`                                  |
| `chat-expand`                             | Renderer → Main | Request an inline word-expansion stream                                                      |
| `chat-expand-chunk`                       | Main → Renderer | Expand chunks (`done`; `cancelled: true` + partial text after stop)                          |
| `chat-replace-conversation`               | Main → Renderer | Hydrate transferred state + id/title/createdAt into the chat window                          |
| `lookup-trigger-grow`                     | Lookup → Main   | On first ask, signal main to animate window growth                                           |
| `lookup-transfer`                         | Lookup → Main   | Send `{state, conversationId?}` to chat; main transforms context, persists                   |
| `ai-error`                                | Main → Lookup   | Capture or OCR error message (sent from lookup.ts & window.ts)                               |
| `lookup-context`                          | Main → Lookup   | OCR context state (`{status, text, hint}`)                                                   |
| `lookup-grow`                             | Main → Lookup   | (`width, height`) signal grow animation on the renderer side                                 |
| `lookup-paste-text`                       | Lookup → Main   | Pasted text replaces OCR context                                                             |
| `lookup-paste-image`                      | Lookup → Main   | Pasted image → OCR → context                                                                 |
| `lookup-ocr-image`                        | Lookup → Main   | Invoke OCR on an image (returns `{text, error?}`)                                            |
| `lookup-input-changed`                    | Lookup → Main   | Whether Ask field has text (guards blur-to-close)                                            |
| `lookup-close`                            | Lookup → Main   | Close the lookup window                                                                      |
| `lookup-ready`                            | Lookup → Main   | Listener-ready handshake; main replays `pendingState` via `lookup-context`                   |
| `load-model-config` / `save-model-config` | Renderer ↔ Main | Model config CRUD (migrated + validated in main)                                             |
| `load-model-catalog`                      | Renderer ↔ Main | models.dev catalog (`force` arg refreshes; cached 24h, offline fallback)                     |
| `load-settings` / `save-settings`         | Renderer ↔ Main | Settings; save registers hotkey first, returns `{ success, hotkeyMode, error? }`             |
| `conversation-save` / `-load` / `-delete` | Renderer → Main | Conversation CRUD to `{userData}/conversations/` (atomic writes)                             |
| `conversation-list`                       | Renderer → Main | List chat-source conversations (metadata sorted by updatedAt desc)                           |
| `conversation-search`                     | Renderer → Main | Search chat titles/content; results extend meta with `matchedIn`/`snippet`                   |
| `conversation-list-unfed` / `-kb-fed`     | Renderer → Main | KB model integration: list unfed; mark fed (+ auto-delete lookup source)                     |
| `conversation-export`                     | Renderer → Main | Save a conversation as markdown (`{ok,path}` or `{ok:false,error}`; cancel is `'Canceled.'`) |
| `kb-load-prompt` / `kb-save-prompt`       | Renderer → Main | Read the learned prompt; save an edited prompt (+ return keywords)                           |
| `kb-reset`                                | Renderer → Main | Delete prompt + keywords + run state; clears `kbFed`; auto rebuilds when enabled             |
| `kb-analyze` / `kb-reanalyze`             | Renderer → Main | Manual maintenance over unfed conversations / the last N                                     |
| `kb-get-status` / `kb-status`             | Renderer ↔ Main | Automatic learning status: invoke a snapshot; main pushes every change                       |

#### Module map

##### Shared (`src/shared/`)

| Module              | Role                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `models.ts`         | Shared types + registries (ProviderType, RoleId, Connection, etc.)                                                                                                                                                            |
| `conversation.ts`   | `ConversationState` / `Turn` (markdown `content` + offset-anchored `expansions`), `ConversationMeta`, `toConversationMeta`, `persistableTurns`, `serializeForChat`, `buildConversationTitle`, `migrateConversationRecord`     |
| `context-budget.ts` | Pure token budgeting: `estimateTokens` (4 chars/token), `budgetFor` (85% of the window minus the output reserve), `trimMessages` (drops oldest non-system messages, never the last)                                           |
| `rich-text.ts`      | Pure rich-text model: `ExpansionNode`, `validateInsertion` / `insertExpansion(InTurns)` / `updateExpansion` / `setExpansionFolded` / `findExpansionIn*` / `maxExpansionId`, `flattenMarkdown`, legacy `migrateLegacySegments` |
| `expand-prompt.ts`  | `buildExpandMessages({answer, selection, prompt?})` — constructs API messages for expand requests                                                                                                                             |
| `prompts.ts`        | All LLM-facing prompt/instruction strings: system prompts, context template, lookup default, expand instructions                                                                                                              |

##### Main process (`src/main/`)

| Module              | Path                          | Role                                                                                                                                                                             |
| ------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App lifecycle       | `index.ts`                    | Main window, tray, streaming IPC (chat-send/expand/cancel), lookup transfer, conversation IPC                                                                                    |
| Conversation store  | `conversations.ts`            | CRUD on `{userData}/conversations/{id}.json` + `{id}.meta.json` sidecars; per-id write chain (`saveConversation`, `mutateConversation`); title+content search, KB-fed mark/reset |
| Conversation export | `conversation-export.ts`      | `renderConversationMarkdown` (expansions quoted inline) + `exportConversationToFile` (save dialog, atomic write)                                                                 |
| Context budget      | `context-budget.ts`           | `applyContextBudget(messages, role)`: trims chat sends to the cached model's window; fail-open on any missing input                                                              |
| Lookup transfer     | `transfer.ts`                 | `prepareTransferredState`: finalizes in-flight frames + folds screen context into a user turn                                                                                    |
| Main window ref     | `main-window.ts`              | Module-scoped getter/setter for BrowserWindow ref; `clearMainWindow()` on `closed` (used by transfer)                                                                            |
| Config              | `config.ts`                   | Settings/config I/O (atomic), hotkey registry (register-first save, startup fallback), Wayland                                                                                   |
| Atomic writes       | `services/atomic-file.ts`     | Temp-file + rename writes (`writeFileAtomic[Sync]`) for config, KB and conversation files                                                                                        |
| Provider dispatch   | `provider.ts`                 | `callProvider` + `callProviderStream(…, signal?)` (resolves role → connection → backend)                                                                                         |
| Model re-exports    | `models/registries.ts`        | Re-exports shared types/registries so main imports stay stable without crossing renderer boundary                                                                                |
| Config schema       | `models/config-schema.ts`     | Zod schema, v1→v3 migrations, repair of dangling roles/unknown providers                                                                                                         |
| Model catalog       | `services/model-catalog.ts`   | models.dev fetch + 24h disk cache (`{userData}/cache/models-dev.json`) + `load-model-catalog` IPC                                                                                |
| KB handlers         | `kb/handlers.ts`              | `kb-*` handlers; `kb-reset` queues the wipe behind running passes via `resetKbProfile`                                                                                           |
| KB scheduler        | `kb/maintenance.ts`           | Automatic learning: debounce, batching, backoff, single-flight queue, `kb-status` push                                                                                           |
| KB run pipeline     | `kb/run.ts`                   | `runKbAnalysis(metas, { markFed, signal })` — folds conversations into prompt + keywords                                                                                         |
| KB pacing policy    | `kb/schedule.ts`              | Pure timing/batch decisions (debounce, backlog, retry backoff, startup delay)                                                                                                    |
| KB store            | `kb/store.ts`                 | `prompt.txt` + `keywords.json` + `state.json` I/O (atomic); `resetKb` deletes all three                                                                                          |
| Lookup orchestrator | `lookup/lookup.ts`            | Hotkey entry point (capture + OCR + create popup)                                                                                                                                |
| Lookup popup window | `lookup/window.ts`            | BrowserWindow + grow animation + ref-counted ocr-image handler                                                                                                                   |
| Capture + OCR       | `lookup/capture.ts`           | Screen capture + tesseract.js worker                                                                                                                                             |
| Handlers            | `lookup/handlers.ts`          | Paste-text and paste-image handlers only (Ask/Expand moved to streaming IPC)                                                                                                     |
| Session state       | `lookup/state.ts`             | LookupSession interface + helpers (sendToSession, notifySessionState, isSessionAlive)                                                                                            |
| Wayland shortcut    | `services/global-shortcut.ts` | XDG GlobalShortcuts portal                                                                                                                                                       |
| KDE screenshot      | `services/screen-capture.ts`  | Screenshot portal (silent)                                                                                                                                                       |

##### Renderer (`src/renderer/src/`)

| Module           | Path                                                     | Role                                                                                                                |
| ---------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Entry point      | `main.tsx`                                               | createRoot, imports CSS, mounts Root                                                                                |
| Root router      | `Root.tsx`                                               | Routes App (main window) vs LookupApp (popup) by `?role=lookup`                                                     |
| App shell        | `App.tsx`                                                | Sidebar + 5-view routing                                                                                            |
| Lookup popup     | `LookupApp.tsx`                                          | Header, context panel, ask input, paste handling, grow transitions                                                  |
| Chat hook        | `hooks/useChatStreaming.ts`                              | Owns ConversationState, stop/retry/regenerate/rename, routes requests via `hooks/chat/*`, auto-saves                |
| Chat requests    | `hooks/chat/{requests,persistence,transport}.ts`         | Pure request book (pending ids, `activeSendId`, drain helpers), autosave effect, IPC subscriptions + stale-id drops |
| Scroll following | `hooks/useStickToBottom.ts`                              | Pins chat/popup views to the bottom while a response streams; an upward scroll unpins                               |
| Conversation     | `components/conversation/Conversation.tsx`               | Message list, composer + Stop button, search overlay, context menu                                                  |
| Turn             | `components/conversation/Turn.tsx`                       | Single message (user/assistant) with avatar, markdown body, retry                                                   |
| Markdown         | `components/conversation/Markdown.tsx`                   | remark → mdast → hast → React; block mode for turns, inline mode+`md-*` spans for frames; `data-src` text anchors   |
| Markdown core    | `lib/markdown.ts`                                        | Pure parse/splice/anchor helpers (`prepareMarkdownTree`, `isAnchoredRange`, `collectTextNodeSpans`)                 |
| ExpansionFrame   | `components/conversation/ExpansionFrame.tsx`             | Inline expandable frames, folded pills, nested children                                                             |
| ContextMenu      | `components/conversation/ContextMenu.tsx`                | Right-click Expand / Expand on… / Copy / Select All                                                                 |
| ExpandPrompt     | `components/conversation/ExpandPrompt.tsx`               | Floating inline input for custom expand direction ("Expand on…")                                                    |
| Search           | `components/conversation/ConversationSearch.tsx`         | Ctrl/Cmd+K modal: search titles + messages, snippet, load/delete, errors                                            |
| Settings         | `views/settings/Settings.tsx`                            | 3-tab settings orchestrator                                                                                         |
| Views            | `views/home/`, `views/knowledge/`, `views/lookup-guide/` | Dashboard and placeholder views                                                                                     |

#### What to touch when

| Task                                   | File(s)                                                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Add an AI provider                     | `provider.ts` (`ROUTES` row: name + base URL, nothing else)                                           |
| Change the OCR/capture pipeline        | `lookup/capture.ts`                                                                                   |
| Change the hotkey response flow        | `lookup/lookup.ts` (`handleHotkeyPressed`)                                                            |
| Change the look-up context source      | `lookup/lookup.ts` (`handleHotkeyPressed`) + `config.ts` + `shared/conversation.ts`                   |
| Reposition / restyle the lookup popup  | `lookup/window.ts` + CSS in `lookup.css`, `LookupApp.tsx`                                             |
| Change the expand prompt               | `shared/expand-prompt.ts` (`buildExpandMessages`)                                                     |
| Change the expand instruction text     | `shared/prompts.ts` (`buildExpandUserInstruction`, `buildExpandPromptedInstruction`)                  |
| Change the Expand Prompt UI            | `components/conversation/ExpandPrompt.tsx`                                                            |
| Change frame fold/unfold behaviour     | `shared/rich-text.ts` (`setExpansionFolded`) + `ExpansionFrame.tsx`                                   |
| Change the expansion targeting logic   | `hooks/useExpansionContextMenu.ts` (DOM→offset mapping) + `shared/rich-text.ts` (`validateInsertion`) |
| Change the expand data model/anchors   | `shared/rich-text.ts` (+ `lib/markdown.ts` splice, `Markdown.tsx` render)                             |
| Add / change markdown rendering        | `components/conversation/Markdown.tsx`, `lib/markdown.ts`, `assets/markdown.css`                      |
| Persist or load user config/settings   | `config.ts`                                                                                           |
| Wayland global-shortcut binding        | `services/global-shortcut.ts`                                                                         |
| KDE Wayland silent screenshot          | `services/screen-capture.ts`                                                                          |
| Add a new IPC channel                  | preload `index.ts` + `.d.ts`, then main `index.ts`                                                    |
| Change the chat streaming hook         | `hooks/useChatStreaming.ts` + `hooks/chat/{requests,persistence,transport}.ts`                        |
| Persist or load conversations          | `conversations.ts` (main) + `useChatStreaming.ts` (renderer)                                          |
| Search conversations                   | `conversations.ts` (`searchConversations`) + `ConversationSearch.tsx`                                 |
| Rename / regenerate a conversation     | `useChatStreaming.ts` (`renameConversation`/`regenerate`) + `Conversation.tsx`, `Turn.tsx`            |
| Export a conversation                  | `conversation-export.ts` + `Conversation.tsx` (button states), preload `exportConversation`           |
| Trim chats to the model context window | `shared/context-budget.ts` (pure) + `main/context-budget.ts` (catalog lookup, fail-open)              |
| KB prompt / fed flags                  | `kb/handlers.ts` + `conversations.ts` (`resetKbFedFlags`) + `KnowledgeView.tsx`                       |
| Automatic learning pacing              | `kb/schedule.ts` (pure) + `kb/maintenance.ts` (timers, queue, status)                                 |
| What gets folded into the profile      | `kb/run.ts` (`runKbAnalysis`) + `kb/analysis.ts` (material/messages)                                  |
| Stop/retry generation                  | `useChatStreaming.ts` (`stop`/`retry`) + `Conversation.tsx`, `Turn.tsx`                               |
| Change chat auto-scroll                | `hooks/useStickToBottom.ts`                                                                           |
| Renderer chat UI                       | `App.tsx`, `Conversation.tsx`, `Turn.tsx`, `ConversationSearch.tsx`                                   |
| Provider config form                   | `components/settings/models/ModelsTab.tsx` (+ `RoleRow.tsx`, `ConnectionCard.tsx`)                    |
| Model picker / catalog                 | `shared/model-catalog.ts` (pure), `services/model-catalog.ts` (fetch+cache)                           |
| Change the model-config schema         | `models/config-schema.ts` — add a vN→vN+1 step, bump `MODEL_CONFIG_VERSION`                           |

#### Important conventions

- **Provider dispatch lives in `provider.ts`.** `callProviderStream(messages, roleId, signal?)`
  reads the config and selects the backend; everyone else (streaming IPC handlers, lookup) calls
  it via the roleId. Don't duplicate `resolveRole()` + provider branching elsewhere.
- **Every provider is one OpenAI-compatible route.** A provider is a `ROUTES` entry (name +
  default base URL); there is no per-provider transport, SDK or tool wiring, and adding one means
  adding a row. Google uses `…/v1beta/openai`. Web-search grounding is deliberately absent: the AI
  SDK only exposes search as provider-specific tools, which would reintroduce the special case.
- **The lookup popup is a 420×320 always-on-top frameless `BrowserWindow`** created in
  `lookup/window.ts` via `createLookupSession`. It loads the **same renderer bundle** as the
  main window, with `?role=lookup` query param (see `Root.tsx`). Position is clamped to the
  cursor display's work area; compositor may centre on Wayland (acceptable). On first ask, grows
  to 840×640 via `animateGrowSession` + `lookup-trigger-grow` IPC.
- **There can be multiple lookup sessions.** The global `lookupSessions` array in `state.ts`
  owns `LookupSession` objects, each holding its window ref, OCR context text, OCR token,
  `grown`, `contextReady`, and `hasText`. Use `isSessionAlive` / `sendToSession` /
  `notifySessionState` rather than touching window refs directly.
- **Lookup blur behaviour:** a window closes on blur only when the user has never focused it,
  is not grown, and the Ask field is empty (`!session.hasText`). Once grown, the window stays
  open on blur so the user can keep consulting it while triggering new lookups.
- **Look-Up Context Source `none` is the default.** `handleHotkeyPressed` creates the popup
  without capturing anything and publishes an empty ready state (`applyOcrResult`), so the Ask
  field works immediately. `clipboard` and `fullscreen-ocr` capture and inject as before.
  `serializeForChat` prepends the screen-context preamble only when `state.context` is
  non-empty, so an empty source (or an empty OCR/clipboard result) sends no context message.
  The `summarize` default applies only when a context exists; manual Ctrl+V still fills it.
  Transfer to chat folds any captured context into the first user turn.
- **Lookup context replay (`lookup-ready`).** `LookupApp.tsx` sends `lookup-ready` after its
  `lookup-context` listener is registered; the per-window handler in `lookup/window.ts` re-sends
  `session.pendingState` if OCR finished before the renderer was listening.
- **OCR captures the full screen**, not a cropped region. `captureScreen()` grabs the entire
  display; `runOCR()` processes the whole image. Cursor position may return `(0,0)` on
  Wayland, but full-screen capture + full-image OCR keeps the feature working regardless.
- **Portal code is KDE/Wayland-specific by design.** `isScreenCapturePortalPreferred()` and
  `isKdeWaylandSession()` gate it. Keep `desktopCapturer` as default for
  X11/macOS/Windows and non-KDE Wayland.
- **Config files** live under `{userData}/config/` (`providers.json`, `settings.json`).
  `settings.json` holds `hotkey`, `closeToTray`, `lookupContextMode`
  (default `'none'`) and `kbAutoMaintain`
  (default `true`); `save-settings` normalizes the whole payload, so a new field must be
  preserved by every `saveSettings` caller (Settings view, Look-Up Guide).
  Always go through `config.ts` helpers; call `ensureConfigDir()` before writing. Writes use
  `services/atomic-file.ts` (sibling temp file + rename), so a crash can't truncate them.
  `save-settings` normalizes the payload and registers the requested hotkey **before**
  persisting. If registration throws or the desktop keeps the previous binding, it returns
  `{ success: false, error }` and does not write the inactive shortcut. A key that only works
  via the in-app fallback is still saved; success returns `{ success, hotkeyMode }`
  (`'global'` = system-wide, `'local'` = in-app fallback), and a failed write returns
  `{ success: false, error }`. The Settings view has no Save button: it autosaves both files on a
  500 ms debounce (baseline seeded after load, flushed on unmount) and shows a failed save inline.
- **`providers.json` is never trusted as-is.** `loadModelConfig` runs it through
  `migrateModelConfig` (zod + migrations + repairs) and writes the repaired file back;
  `saveModelConfig` validates before writing and returns `{ ok, error }`. An empty
  `connectionId` is normalized to `null` (unassigned) instead of discarding the config. Any
  new schema version needs a step in `MIGRATIONS` in `models/config-schema.ts`.
- **Model lists come from models.dev, not `knownModels`.** `services/model-catalog.ts`
  fetches `https://models.dev/api.json`, keeps only the provider types in
  `CATALOG_PROVIDER_IDS`, caches it for 24h and falls back to the cached copy when offline.
  `knownModels` in `shared/models.ts` is only the offline fallback for the picker;
  `ollama` / `openai-compatible` have no catalog entries and stay free-text.
- **Conversation files** live under `{userData}/conversations/`: `{id}.json` holds the record and
  `{id}.meta.json` holds its `ConversationMeta` (id, title, timestamps, source, `kbFed`,
  `turnCount`). Always go through `conversations.ts` helpers; `ensureConversationsDir()` is called
  automatically by save/list operations. Every successful write updates the body and the sidecar
  atomically (temp file + rename); `deleteConversation` removes both. `listConversations`,
  `searchConversations` and `listUnfedConversations` read sidecars and **backfill** a missing or
  corrupt sidecar from the body inside the write chain. Ids are validated against
  `SAFE_CONVERSATION_ID` before touching the filesystem.
  Writes for one id are serialized by a per-id chain; use `saveConversation` for whole-record
  writes and `mutateConversation(id, mutate)` for read-modify-write (KB-fed marking/reset). A
  mutation runs inside the same chain, so it cannot overwrite a newer autosave with the body it
  read first; returning `false` from the mutator cancels the write.
  `searchConversations` scans chat records by title and flattened turn content, ranking title
  matches first and returning a ±80-char excerpt around the newest matching turn (limit 100).
- **Hotkey registry** is in `config.ts:registerHotkey`. It auto-routes through the XDG
  portal on Wayland. `save-settings` calls it with `handleHotkeyPressed` before persisting —
  keep that callback wiring intact. Startup registration is wrapped too: if the stored hotkey
  throws, `index.ts` logs, retries `DEFAULT_HOTKEY`, and still opens the window.
- **`path` vs `path/posix`**: `config.ts` and `index.ts` use `path`,
  `lookup/capture.ts` and `lookup/window.ts` use `path/posix`. The tesseract cache path
  uses `path/posix` deliberately — match the existing import in the file you're editing.
- **`@renderer` path alias** is defined in `electron.vite.config.ts` as
  `src/renderer/src` and available for renderer imports, though current code uses
  relative paths to `shared/` instead.
- **Tray support**: `index.ts` creates a `Tray` with context menu (New Look-up, Show Delta AI, Quit);
  `createTray()` is idempotent, so repeated `whenReady` paths cannot stack trays.
  `config.ts:currentCloseToTray` controls whether closing the main window hides to tray
  instead of quitting. The `close` handler in `createWindow` checks
  `currentCloseToTray && !isQuitting`, and `closed` clears the module ref via `clearMainWindow()`.
- **Shared streaming IPC (`chat-send`/`chat-expand`/`chat-cancel`)** responds via `safeSend`,
  which drops the message when the sender is destroyed. All responses are scoped to the sending
  webContents — safe for both windows to use the same channel family. `activeStreams` stores
  `{controller, senderId}` per `requestId`; a destroyed sender aborts its stream, and only the
  webContents that started a request may cancel it. The `role` payload field routes to the
  correct roleId (`'chat'` or `'lookup'`) for `callProviderStream`. A cancelled send ends with
  `chat-response { text: partial, cancelled: true }`, a cancelled expand with
  `chat-expand-chunk { text: partial, done: true, cancelled: true }`. The renderer leaves a
  settled request out of its request book, so late chunks for it are no-ops.
- **Chat sends are context-budgeted; lookup sends are not.** After the KB prompt is inserted,
  `applyContextBudget(messages, 'chat')` drops the oldest non-system messages until the estimate
  fits 85% of the model's context window minus its output reserve. It is fail-open: an unassigned
  role, unknown model, missing `contextWindow`, or any error returns the messages untouched.
  Quality of the current turn must never depend on catalog availability.
- **Expand data model is offset-anchored markdown, not DOM-first.** A turn is
  `{ content: markdown, expansions: ExpansionNode[] }`. Each node stores absolute
  `[start, end)` offsets into `content` (or into its parent's `answer` for nested frames),
  the `originalText` snapshot, the streamed markdown `answer`, `status`, `folded`, and
  `children`. Every mutation is a pure function in `shared/rich-text.ts`; `ExpansionFrame`
  re-renders from that data. There is exactly one copy of the text.
- **Transfer (lookup → chat) marshals the full `ConversationState`** via
  `lookup-transfer` IPC. The main process transforms screen context into a user turn
  via `buildScreenContextMessage`, then **persists before it closes anything**: a failed save is
  reported to the popup (`ai-error`) and the popup stays open so the chat is not lost. Only after
  a successful write does it close the popup and deliver
  `{state, conversationId, conversationTitle, conversationCreatedAt}`, either to the existing
  main window or to a freshly created one once its renderer finishes loading. The chat hook
  cancels every in-flight request, hydrates the payload into its `useState`, seeds its meta from
  `conversationCreatedAt` so later saves update the same record, and resets
  `expansionIdCounter` past the max imported id. No DOM serialization needed.
- **Conversation auto-save fires on response completion (including stopped/partial), error,
  expand done, fold, and unfold.** `hooks/chat/persistence.ts` turns the newest state into a
  record via `persistableTurns()` (blank assistant placeholders dropped) and skips conversations
  with no persistable turns. Saves are serialised per id in main, transient `loading` expansions
  are finalised into errors before writing, and the record carries `updatedAt` (last _content_
  change) — fold/dismiss/rename never bump content recency, so they cannot reorder recents.
  `createdAt` is set once on the first send, and renderer autosaves preserve `kbFed` (main merges
  it from the existing file). A stop after output keeps the partial text and saves it; a stop
  before the first token saves only the user turn. Empty conversations are never saved. Error
  turns are persisted for Retry.
- **Stop/retry/regenerate live in the chat window**: while loading, the composer send button
  becomes a Stop button wired to `stop()`, which cancels in-flight expands first and then the
  active send. An assistant turn with `error: true` renders Retry; `retry(turnId)` and
  `regenerate(turnId)` share `replaceAssistantTurn`, dropping that answer and everything after
  it, keeping the preceding user turn, and re-sending the serialized conversation. Regenerate is
  also offered on successful answers and confirms when later turns would be dropped.
  `serializeForChat` omits assistant turns that are `error: true` or have blank/whitespace
  content (in-flight/legacy placeholders), so neither error text nor empty placeholders are
  replayed to the model; error turns stay on disk so Retry survives a reload.
- **Auto-scroll is a pin, not a proximity check.** `hooks/useStickToBottom.ts` follows new
  chunks only while the reader is at the bottom. Scrolling up unpins the view immediately, so
  streaming can never drag the reader back down; returning to the bottom, clicking Latest, or
  sending a message re-pins. The main chat and the lookup popup share the hook.
- **Every navigation action drops its in-flight requests.** `stop`, `newChat`, `loadConversation`
  and conversation replacement cancel all pending ids, while `retry`/`regenerate` cancel only
  expands attached to the turns they drop. The request book (`hooks/chat/requests.ts`) is
  updated before `chatCancel`, so late chunks for a dropped id are no-ops rather than writes to
  a turn that no longer exists.
- **Rename is metadata-only.** `renameConversation(title)` trims to the title limit, updates the
  in-memory meta and saves with `touchContent: false`: the body's `title` changes but
  `updatedAt` does not, so the recents list keeps its order. Inline editing in
  `Conversation.tsx` commits on blur/Enter and cancels on Escape.
- **Export writes markdown through the main process.** `conversation-export` renders the record
  (expansions quoted one level deeper per reply, failed/blank assistant turns skipped) and writes
  it atomically to the path chosen in the system save dialog. The UI shows
  idle → `Exporting…` → `Saved` (2s) or an inline error; the `'Canceled.'` error is a no-op.
- **KB maintenance is automatic.** `kb/maintenance.ts` subscribes to `onConversationSaved`
  (`conversations.ts`) and `onAppConfigChanged` (`config.ts`). A save starts a 20s-debounced
  pass that folds at most 4 newest unfed chat conversations into `prompt.txt` through the
  `kb-maintenance` role; a backlog continues every 45s, failures back off 2m → 30m, and
  `kb/state.json` persists pacing/error state. All runs (manual or automatic) share one queue,
  so writes never interleave. Nothing runs without a `kb-maintenance` model, and
  `settings.json → kbAutoMaintain` (default true, Settings → General) stops it. Status is pushed
  as `kb-status`; the Knowledge view renders it, and the Home view refreshes its tags.
- **KB reset (`kb-reset`) is queued behind running passes.** `resetKbProfile()` aborts the
  in-flight pass, deletes `{userData}/kb/prompt.txt` + `keywords.json` + `state.json`, and clears
  `kbFed` on chat records via `resetKbFedFlags()` (lookup records are untouched). Conversation
  history stays on disk, so automatic learning rebuilds the profile from it when enabled;
  the Knowledge view refreshes its status and its confirm text says history is retained.
  `kb-save-prompt` writes an edited prompt atomically; the next automatic pass treats it as the
  baseline to refine rather than replacing it from scratch.
- **Markdown is rendered, never flattened for display.** `Markdown.tsx` runs
  `remark-parse` + `remark-gfm` → `mdast-util-to-hast` → `hast-util-to-jsx-runtime`. Every
  mdast text node becomes `<span data-src={absoluteOffset}>text</span>`: that span _is_ the
  DOM↔source map. Two component maps: block mode (real `p`, `ul`, `ol`, `li`, `pre`,
  `table`, `blockquote`, `h1-3`) for turn content, and inline mode (only `span`/`code`/
  `strong`/`em`/`del`/`a`, with `md-p`/`md-list`/`md-li`/`md-pre`/… classes) inside an
  expansion frame, whose host is a `<span>`. `flattenMarkdown` remains only for titles and
  search.
- **Selections are mapped by offset, never by string search.** `useExpansionContextMenu`
  resolves each Range endpoint to its nearest `[data-src]` leaf plus the character offset,
  refusing when the endpoints live in different scopes (turn vs. frame). A range is
  expandable only if it lies inside one mdast text node (`isAnchoredRange`) and
  `validateInsertion` accepts it: non-empty, in bounds, not crossing a block boundary, and
  not overlapping an existing expansion (nesting must target the parent frame explicitly).
  No `Range` objects survive into React state.
- **Cross-frame selections disable Expand.** A selection spanning an expansion boundary
  overlaps that expansion's source range, which `validateInsertion` refuses; the menu item
  renders disabled. The same function is shared by the menu (preview) and `expand()`
  (commit), so they cannot disagree.
- **Legacy conversations migrate at the load boundary.** `loadConversation` in
  `conversations.ts` runs `migrateConversationRecord`; turns carrying the old
  `ExpandableSegment[]` tree are rebuilt into `{ content, expansions }` (flattened text —
  the old renderer had already stripped markdown). Nothing in the renderer knows about
  segments.
- **Custom expansion prompt ("Expand on…")** opens a floating `ExpandPrompt` input at the
  right-click position. It appears as a third item in the context menu. On submit,
  the prompt text (defaulting to `"elaborate on"` if empty) replaces the `"Define..."`
  instruction via `buildExpandPromptedInstruction` in `prompts.ts`.

#### More Details

Refer to `docs/architecture.md` for more details.

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
  `docs/architecture.md` (section 7). Do not introduce CSS-in-JS or Tailwind without discussion.
  Reuse `.btn` and `.field` from `base.css` rather than hand-rolling a button or input style.
- Keep the renderer thin: it talks only to `window.api`. Privileged work belongs in the
  main process.
