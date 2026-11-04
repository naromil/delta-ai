# Delta AI

Electron desktop app (BYOK) with a ChatGPT-like chat UI (React 19), an infinite canvas of
answer rectangles, and an always-on-top lookup popup that performs OCR on screen captures via
global hotkey.
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
- Don't commit secrets. API keys live only in `{userData}/config/providers.json`, sealed with
  `safeStorage` (`services/secret-store.ts`). Never send a stored key to the renderer.
- Every `BrowserWindow` is `sandbox: true` and must call `guardWindowNavigation` (`window-guards.ts`)
  so no remote page can load next to the preload bridge. The preload exposes only `window.api`.
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

| Channel                                   | Direction       | Purpose                                                                                         |
| ----------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------- |
| `chat-send`                               | Renderer → Main | Send a streaming chat message (role payload discriminates 'chat' vs 'lookup')                   |
| `chat-chunk`                              | Main → Renderer | Batched `delta` for a chat-send request (keyed by `requestId`); final text is in response       |
| `chat-response`                           | Main → Renderer | Final response for a chat-send (`cancelled: true` + partial text after stop)                    |
| `chat-error`                              | Main → Renderer | Error for a chat-send                                                                           |
| `chat-cancel`                             | Renderer → Main | Abort an in-flight `chat-send`/`chat-expand` by `requestId`                                     |
| `chat-image-support`                      | Renderer → Main | Whether a role's model reads images (`yes` / `no` / `unknown`); the composer asks on attach     |
| `chat-expand`                             | Renderer → Main | Request an inline word-expansion stream                                                         |
| `chat-expand-chunk`                       | Main → Renderer | Expand chunks (`done`; `cancelled: true` + partial text after stop)                             |
| `chat-replace-conversation`               | Main → Renderer | Hydrate transferred state + id/title/createdAt into the chat window                             |
| `lookup-trigger-grow`                     | Lookup → Main   | On first ask, signal main to animate window growth                                              |
| `lookup-transfer`                         | Lookup → Main   | Send `{state, conversationId?}` to chat; main transforms context, persists                      |
| `ai-error`                                | Main → Lookup   | Capture or OCR error message (sent from lookup.ts & window.ts)                                  |
| `lookup-context`                          | Main → Lookup   | OCR context state (`{status, text, hint}`)                                                      |
| `lookup-grow`                             | Main → Lookup   | (`width, height`) signal grow animation on the renderer side                                    |
| `lookup-paste-text`                       | Lookup → Main   | Pasted text replaces OCR context                                                                |
| `lookup-paste-image`                      | Lookup → Main   | Pasted image → OCR → context                                                                    |
| `lookup-ocr-image`                        | Lookup → Main   | Invoke OCR on an image (returns `{text, error?}`)                                               |
| `lookup-input-changed`                    | Lookup → Main   | Whether Ask field has text (guards blur-to-close)                                               |
| `lookup-close`                            | Lookup → Main   | Close the lookup window                                                                         |
| `lookup-ready`                            | Lookup → Main   | Listener-ready handshake; main replays `pendingState` via `lookup-context`                      |
| `load-model-config` / `save-model-config` | Renderer ↔ Main | Model config CRUD (migrated + validated in main)                                                |
| `load-model-catalog`                      | Renderer ↔ Main | models.dev catalog (`force` arg refreshes; cached 24h, offline fallback)                        |
| `load-settings` / `save-settings`         | Renderer ↔ Main | Settings; save takes a partial patch, registers hotkey first, `{ success, hotkeyMode, error? }` |
| `conversation-save` / `-load` / `-delete` | Renderer → Main | Conversation CRUD to `{userData}/conversations/` (atomic writes)                                |
| `conversation-list`                       | Renderer → Main | List chat-source conversations (metadata sorted by updatedAt desc)                              |
| `conversation-search`                     | Renderer → Main | Search chat titles/content; results extend meta with `matchedIn`/`snippet`                      |
| `canvas-list`                             | Renderer → Main | List canvases (`source: 'canvas'` metadata sorted by updatedAt desc)                            |
| `conversation-list-unfed` / `-kb-fed`     | Renderer → Main | KB model integration: list unfed; mark fed                                                      |
| `conversation-export`                     | Renderer → Main | Save a conversation as markdown (`{ok,path}` or `{ok:false,error}`; cancel is `'Canceled.'`)    |

| `kb-analyze` / `kb-reanalyze` | Renderer → Main | Manual curator passes over unfed conversations / the last N |
| `kb-get-status` / `kb-status` | Renderer ↔ Main | Automatic learning status: invoke a snapshot; main pushes every change |
| `memory-updated` | Main → Renderer | The document base changed (any writer); every window shows a transient indicator |

#### Module map

##### Shared (`src/shared/`)

| Module                | Role                                                                                                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `models.ts`           | Shared types + registries (ProviderType, RoleId, Connection, etc.)                                                                                                                                                            |
| `conversation.ts`     | `ConversationState` / `Turn` (markdown `content` + offset-anchored `expansions`), `ConversationMeta`, `toConversationMeta`, `persistableTurns`, `serializeForChat`, `buildConversationTitle`, `migrateConversationRecord`     |
| `context-budget.ts`   | Pure token budgeting: `estimateTokens` (4 chars/token), `budgetFor` (85% of the window minus the output reserve), `trimMessages` (drops oldest non-system messages, never the last)                                           |
| `rich-text.ts`        | Pure rich-text model: `ExpansionNode`, `validateInsertion` / `insertExpansion(InTurns)` / `updateExpansion` / `setExpansionFolded` / `findExpansionIn*` / `maxExpansionId`, `flattenMarkdown`, legacy `migrateLegacySegments` |
| `expand-prompt.ts`    | `buildExpandRequest(state, turn, parentId, range, role, prompt?, attachments?)` — a follow-up's messages at that turn, ancestor chain, instruction; `buildExpandMessages` assembles the branch                                |
| `attachments.ts`      | `ImageAttachment`, per-message/size limits, `isImageInput` / `isImageAttachment` validation, `scaledImageSize`                                                                                                                |
| `canvas.ts`           | Pure canvas model: card types, rectangles, snapping, `estimateWords`, `withCanvasFit`, `resolveMove`, session walks (`turnsThroughCard`), `linkPath`, viewport math, `normalizeCanvasLayout`                                  |
| `canvas-selection.ts` | What a selection covers: `marqueeHits`, `movingForSelection` (frames bring contents, cards bring what is joined), `sessionAncestorIds`, `cardAtPoint`, `selectionMarkdown`, `sourceExcerpts`                                  |
| `canvas-arrange.ts`   | Rigid blocks: `alignSelection`, `distributeSelection`, `tidySelection`, `duplicateSelection`; never overlaps what stands on the plane                                                                                         |
| `canvas-history.ts`   | Undo as patches: `diffCanvas`, `applyCanvasPatch` (leaves what the patch did not touch, refuses a turn that moved on or a landing that is taken)                                                                              |
| `canvas-outline.ts`   | The canvas as a list: `canvasOutline`, `searchCanvasOutline`                                                                                                                                                                  |
| `canvas-context.ts`   | What links send: `sessionContextLinks`, `contextExcerpts` (limits, shared history once), `requestContext`                                                                                                                     |
| `prompts.ts`          | All LLM-facing prompt/instruction strings: system prompts, context template, lookup default, expand instructions                                                                                                              |

##### Main process (`src/main/`)

| Module              | Path                          | Role                                                                                                                                                                                  |
| ------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App lifecycle       | `index.ts`                    | Main window, tray, streaming IPC (chat-send/expand/cancel), lookup transfer, conversation IPC                                                                                         |
| Conversation store  | `conversations.ts`            | CRUD on `{userData}/conversations/{id}.json` + `{id}.meta.json` sidecars; per-id write chain (`saveConversation`, `mutateConversation`); title+content search, KB-fed mark            |
| Image support       | `image-support.ts`            | `modelImageSupport(role)` (catalog modalities, fail-open) + `fitImagesToSupport` (refuse current, drop history images)                                                                |
| Conversation export | `conversation-export.ts`      | `renderConversationMarkdown` (expansions quoted inline) + `exportConversationToFile` (save dialog, atomic write)                                                                      |
| Memory store        | `memory/store.ts`             | Shell-like ops confined to `{userData}/memories/` (`listMemories`, `readMemory`, `readAutoLoadedMemories`, `grepMemories`, `writeMemory`, `editMemory`, `moveMemory`, `removeMemory`) |
| Memory tools        | `memory/tools.ts`             | `memory_*` AI SDK tools + `memoryAgentFor(role)` (assistant vs curator prompt, catalog gate, fail-open) + `memory-updated` broadcast                                                  |
| Context budget      | `context-budget.ts`           | `applyContextBudget(messages, role)`: trims sends to the cached model's window; fail-open on any missing input                                                                        |
| Streaming helpers   | `streaming.ts`                | IPC payload validation, `withInstructions`, `createChunkBatcher` (32 ms token deltas)                                                                                                 |
| Window guards       | `window-guards.ts`            | `guardWindowNavigation`: deny window.open / navigation, hand http(s) links to the browser                                                                                             |
| Secret store        | `services/secret-store.ts`    | `sealSecret` / `openSecret` for API keys (`safeStorage`, `enc:v1:` prefix, plaintext fallback)                                                                                        |
| Lookup transfer     | `transfer.ts`                 | `prepareTransferredState`: finalizes in-flight frames + folds screen context into a user turn                                                                                         |
| Main window ref     | `main-window.ts`              | Module-scoped getter/setter for BrowserWindow ref; `clearMainWindow()` on `closed` (used by transfer)                                                                                 |
| Config              | `config.ts`                   | Settings/config I/O (atomic), hotkey registry (register-first save, startup fallback), Wayland                                                                                        |
| Atomic writes       | `services/atomic-file.ts`     | Temp-file + rename writes (`writeFileAtomic[Sync]`) for config, KB and conversation files                                                                                             |
| Provider dispatch   | `provider.ts`                 | `callProvider` + `callProviderStream(…, signal?)` (resolves role → connection → backend)                                                                                              |
| Model re-exports    | `models/registries.ts`        | Re-exports shared types/registries so main imports stay stable without crossing renderer boundary                                                                                     |
| Config schema       | `models/config-schema.ts`     | Zod schema, v1→v3 migrations, repair of dangling roles/unknown providers                                                                                                              |
| Model catalog       | `services/model-catalog.ts`   | models.dev fetch + 24h disk cache (`{userData}/cache/models-dev.json`) + `load-model-catalog` IPC                                                                                     |
| KB handlers         | `kb/handlers.ts`              | `kb-*` handlers: status and manual curator passes                                                                                                                                     |
| KB scheduler        | `kb/maintenance.ts`           | Automatic learning: debounce, batching, backoff, single-flight queue, `kb-status` push                                                                                                |
| KB run pipeline     | `kb/run.ts`                   | `runKbAnalysis(metas, { markFed, signal })` — curates conversations into the document base                                                                                            |
| KB pacing policy    | `kb/schedule.ts`              | Pure timing/batch decisions (debounce, backlog, retry backoff, startup delay)                                                                                                         |
| KB store            | `kb/store.ts`                 | `state.json` I/O (atomic): pacing and last error                                                                                                                                      |
| Lookup orchestrator | `lookup/lookup.ts`            | Hotkey entry point (capture + OCR + create popup)                                                                                                                                     |
| Lookup popup window | `lookup/window.ts`            | BrowserWindow + grow animation + ref-counted ocr-image handler                                                                                                                        |
| Capture + OCR       | `lookup/capture.ts`           | Screen capture + tesseract.js worker (bundled `eng` traineddata, never downloaded)                                                                                                    |
| Handlers            | `lookup/handlers.ts`          | Paste-text and paste-image handlers only (Ask/Expand moved to streaming IPC)                                                                                                          |
| Session state       | `lookup/state.ts`             | LookupSession interface + helpers (sendToSession, notifySessionState, isSessionAlive)                                                                                                 |
| Wayland shortcut    | `services/global-shortcut.ts` | XDG GlobalShortcuts portal                                                                                                                                                            |
| KDE screenshot      | `services/screen-capture.ts`  | Screenshot portal (silent)                                                                                                                                                            |

##### Renderer (`src/renderer/src/`)

| Module           | Path                                                       | Role                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Entry point      | `main.tsx`                                                 | createRoot, imports CSS, mounts Root                                                                                                                         |
| Root router      | `Root.tsx`                                                 | Routes App (main window) vs LookupApp (popup) by `?role=lookup`                                                                                              |
| App shell        | `App.tsx`                                                  | Sidebar + 6-view routing, global Ctrl+N/Ctrl+K, search modal, composer draft                                                                                 |
| Lookup popup     | `LookupApp.tsx`                                            | Header, context panel, ask input, paste handling, grow transitions                                                                                           |
| Chat hook        | `hooks/useChatStreaming.ts`                                | Owns ConversationState, stop/retry/regenerate/rename, routes requests via `hooks/chat/*`, auto-saves                                                         |
| Chat requests    | `hooks/chat/{requests,persistence,transport}.ts`           | Pure request book (pending ids, `activeSendId`, drain helpers), autosave effect, IPC subscriptions + stale-id drops                                          |
| Canvas state     | `hooks/useCanvas.ts`                                       | Open canvas, its streams and autosave; lives in `App` so answers survive a view change                                                                       |
| Canvas view      | `views/canvas/*`                                           | `CanvasView` (gestures, follow), `CanvasCardView`, `CanvasNoteView`, `CanvasFrames`, `CanvasDraft`, `CanvasLinks`, `CanvasShortcuts`; styles in `canvas.css` |
| Canvas chrome    | `views/canvas/*`                                           | `CanvasToolRail`, `CanvasSelectionBar`, `CanvasOutline`, `CanvasMinimap`, `canvas-menus.ts` (right-click lists)                                              |
| Canvas input     | `views/canvas/useCanvasKeyboard.ts`, `useEdgePan.ts`       | Board-wide keys and paste; panning while a drag is near the edge of the view                                                                                 |
| Viewport motion  | `lib/viewport-motion.ts`                                   | Eases wheel zoom/pan and paints frames directly; React gets the viewport once it rests                                                                       |
| Scroll following | `hooks/useStickToBottom.ts`                                | Pins chat/popup views to the bottom while a response streams; an upward scroll unpins                                                                        |
| Conversation     | `components/conversation/Conversation.tsx`                 | Message list, composer + Stop button (Esc), toolbar (export/delete), context menu                                                                            |
| Turn             | `components/conversation/Turn.tsx`                         | Single message (user/assistant) with avatar, markdown body, retry, inline edit-and-resend                                                                    |
| Markdown         | `components/conversation/Markdown.tsx`                     | remark → mdast → hast → React; block mode for turns, inline mode+`md-*` spans for frames; `data-src` text anchors                                            |
| Markdown core    | `lib/markdown.ts`                                          | Pure parse/splice/anchor helpers (`prepareMarkdownTree`, `anchoredRange`, `isAnchoredRange`), math delimiters                                                |
| Code / math      | `lib/highlight.ts`, `lib/math.ts`                          | lowlight → hast (text-preserving) and KaTeX → HTML (`trust: false`)                                                                                          |
| Image attach     | `lib/image-attachments.ts`, `hooks/useImageAttachments.ts` | Decode + scale + re-encode to JPEG; composer add flow (capability check, limits, notices)                                                                    |
| ExpansionFrame   | `components/conversation/ExpansionFrame.tsx`               | Inline expandable frames, folded pills, nested children                                                                                                      |
| ContextMenu      | `components/conversation/ContextMenu.tsx`                  | Right-click Expand / Expand on… / Copy / Select All; also the list of answers on one range (`items`)                                                         |
| ExpandPrompt     | `components/conversation/ExpandPrompt.tsx`                 | Floating input for a custom question ("Expand on…", "Ask…"), plus the one-click intents                                                                      |
| Selection bar    | `components/conversation/ExpandSelectionBar.tsx`           | Floats over a selection in an answer: Expand, intents, Ask…                                                                                                  |
| Search           | `components/conversation/ConversationSearch.tsx`           | Ctrl/Cmd+K modal: search titles + messages, snippet, load/delete, errors                                                                                     |
| Settings         | `views/settings/Settings.tsx`                              | 3-tab settings orchestrator                                                                                                                                  |
| Memory indicator | `components/MemoryIndicator.tsx`                           | Transient "Memory updated" pill in both windows, driven by `memory-updated`                                                                                  |
| Views            | `views/home/`, `views/knowledge/`, `views/lookup-guide/`   | Dashboard (recent conversations) and placeholder views                                                                                                       |

#### What to touch when

| Task                                   | File(s)                                                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Add an AI provider                     | `provider.ts` (`ROUTES` row: name + base URL, nothing else)                                                                |
| Change the OCR/capture pipeline        | `lookup/capture.ts`                                                                                                        |
| Change the hotkey response flow        | `lookup/lookup.ts` (`handleHotkeyPressed`)                                                                                 |
| Change the look-up context source      | `lookup/lookup.ts` (`handleHotkeyPressed`) + `config.ts` + `shared/conversation.ts`                                        |
| Reposition / restyle the lookup popup  | `lookup/window.ts` + CSS in `lookup.css`, `LookupApp.tsx`                                                                  |
| Change what an expansion request sends | `shared/expand-prompt.ts` (`buildExpandRequest`)                                                                           |
| Change the one-click expand questions  | `shared/prompts.ts` (`EXPAND_INTENTS`)                                                                                     |
| Change the expand selection bar/keys   | `hooks/useExpansionContextMenu.ts` + `ExpandSelectionBar.tsx`                                                              |
| Change frame actions                   | `ExpansionFrame.tsx` + `useChatStreaming.ts` (`retryExpansion`/`editExpansion`/`dismissExpansion`)                         |
| Change the expand instruction text     | `shared/prompts.ts` (`buildExpandUserInstruction`, `buildExpandPromptedInstruction`)                                       |
| Change the Expand Prompt UI            | `components/conversation/ExpandPrompt.tsx`                                                                                 |
| Change frame fold/unfold behaviour     | `shared/rich-text.ts` (`setExpansionFolded`) + `ExpansionFrame.tsx`                                                        |
| Change the expansion targeting logic   | `hooks/useExpansionContextMenu.ts` (DOM→offset mapping) + `shared/rich-text.ts` (`validateInsertion`)                      |
| Change the expand data model/anchors   | `shared/rich-text.ts` (+ `lib/markdown.ts` splice, `Markdown.tsx` render)                                                  |
| Add / change markdown rendering        | `components/conversation/Markdown.tsx`, `lib/markdown.ts`, `assets/markdown.css`                                           |
| Syntax highlighting                    | `lib/highlight.ts` + `hljs-*` rules in `assets/markdown.css` + `--code-*` tokens                                           |
| Math rendering / delimiters            | `lib/markdown.ts` (`parseMarkdown`), `lib/math.ts`, `Markdown.tsx` (`MathFormula`)                                         |
| Light/dark theme or palette            | `config.ts` (`theme`) + light `:root` block in `assets/base.css`                                                           |
| Image attachments                      | `shared/attachments.ts`, `main/image-support.ts`, `provider.ts` (`toModelMessage`), `Conversation.tsx`                     |
| Persist or load user config/settings   | `config.ts`                                                                                                                |
| Wayland global-shortcut binding        | `services/global-shortcut.ts`                                                                                              |
| KDE Wayland silent screenshot          | `services/screen-capture.ts`                                                                                               |
| Add a new IPC channel                  | preload `index.ts` + `.d.ts`, then main `index.ts`                                                                         |
| Change the chat streaming hook         | `hooks/useChatStreaming.ts` + `hooks/chat/{requests,persistence,transport}.ts`                                             |
| Persist or load conversations          | `conversations.ts` (main) + `useChatStreaming.ts` (renderer)                                                               |
| Search conversations                   | `conversations.ts` (`searchConversations`) + `ConversationSearch.tsx`                                                      |
| Rename / regenerate a conversation     | `useChatStreaming.ts` (`renameConversation`/`regenerate`) + `Conversation.tsx`, `Turn.tsx`                                 |
| Export a conversation                  | `conversation-export.ts` + `Conversation.tsx` (button states), preload `exportConversation`                                |
| Trim chats to the model context window | `shared/context-budget.ts` (pure) + `main/context-budget.ts` (catalog lookup, fail-open)                                   |
| KB view / fed flags                    | `kb/handlers.ts` + `conversations.ts` (`markConversationKbFed`) + `KnowledgeView.tsx`                                      |
| Automatic learning pacing              | `kb/schedule.ts` (pure) + `kb/maintenance.ts` (timers, queue, status)                                                      |
| What the curator is given              | `kb/run.ts` (`runKbAnalysis`) + `kb/analysis.ts` (material/messages)                                                       |
| Stop/retry generation                  | `useChatStreaming.ts` (`stop`/`retry`) + `Conversation.tsx`, `Turn.tsx`                                                    |
| Edit and resend a user message         | `useChatStreaming.ts` (`editMessage` → `truncateAndResend`) + `Turn.tsx`, `Conversation.tsx`                               |
| Delete the open conversation           | `useChatStreaming.ts` (`deleteConversation`) + `Conversation.tsx` toolbar                                                  |
| App-wide shortcuts / search modal      | `App.tsx` (Ctrl/Cmd+N, Ctrl/Cmd+K, `ConversationSearch` mount)                                                             |
| Change chat auto-scroll                | `hooks/useStickToBottom.ts`                                                                                                |
| Renderer chat UI                       | `App.tsx`, `Conversation.tsx`, `Turn.tsx`, `ConversationSearch.tsx`                                                        |
| Agent memory tools / document base     | `memory/store.ts` (ops + confinement), `memory/tools.ts` (tool set), `shared/prompts.ts` (rules)                           |
| What the curator saves                 | `shared/prompts.ts` (`KB_MEMORY_SYSTEM_PROMPT`), `kb/run.ts` (`updateMemories`)                                            |
| Memory updated indicator               | `components/MemoryIndicator.tsx`, `memory/tools.ts` (`broadcastMemoryUpdated`)                                             |
| Canvas geometry, sessions, word fit    | `shared/canvas.ts` (+ `estimateWords` constants mirror `assets/canvas.css`)                                                |
| Canvas gestures, tools, expansion flow | `views/canvas/CanvasView.tsx`                                                                                              |
| Canvas card height and pushing         | `shared/canvas.ts` (`resizeCard`, `fitCardHeight`), measured in `CanvasView.tsx`                                           |
| Canvas card buttons                    | `views/canvas/CanvasCardView.tsx`, `hooks/useCanvas.ts` (`regenerateCard`, `editCard`)                                     |
| Canvas streaming and saving            | `hooks/useCanvas.ts`                                                                                                       |
| Canvas sizing instruction              | `shared/prompts.ts` (`buildCanvasFitNote`)                                                                                 |
| Canvas composer, follow, links         | `views/canvas/CanvasView.tsx` (+ `nearestCardInDirection` in `canvas.ts`)                                                  |
| Canvas session links and seams         | `shared/canvas.ts` (`canvasContinuations`) + `views/canvas/CanvasLinks.tsx`                                                |
| Canvas keys                            | `views/canvas/useCanvasKeyboard.ts` + `CanvasShortcuts.tsx` (the list); a focused card's own keys in `handleCardKeyDown`   |
| Canvas tools                           | `views/canvas/CanvasToolRail.tsx` (+ `handleSurfaceDown` and `finishDraw` in `CanvasView.tsx`)                             |
| Canvas selection and what it moves     | `shared/canvas-selection.ts`, `handleDragStart` in `CanvasView.tsx`                                                        |
| Canvas align, tidy, duplicate          | `shared/canvas-arrange.ts`, `CanvasSelectionBar.tsx`                                                                       |
| Canvas undo                            | `shared/canvas-history.ts`, `recorded` in `hooks/useCanvas.ts`                                                             |
| Canvas notes, frames, connections      | `shared/canvas.ts` (types, `normalizeCanvasLayout`), `hooks/useCanvas.ts`, `CanvasNoteView`, `CanvasFrames`, `CanvasLinks` |
| Asking about selected cards            | `shared/canvas-selection.ts` (`sourceExcerpts`), `shared/prompts.ts` (`buildCanvasSourcesNote`), `askAboutSelection`       |
| Canvas map, outline and search         | `CanvasMinimap.tsx`, `CanvasOutline.tsx`, `shared/canvas-outline.ts`                                                       |
| Context links, composer attachments    | `shared/canvas-context.ts`, `shared/prompts.ts` (`buildCanvasContextNote`), `CanvasDraft.tsx`, `linkMenuItems`             |
| Resizing a draft                       | `shared/canvas.ts` (`resizeDraftRect`), `draftResize` gesture in `CanvasView.tsx`                                          |
| Provider config form                   | `components/settings/models/ModelsTab.tsx` (+ `RoleRow.tsx`, `ConnectionCard.tsx`)                                         |
| Model picker / catalog                 | `shared/model-catalog.ts` (pure), `services/model-catalog.ts` (fetch+cache)                                                |
| Change the model-config schema         | `models/config-schema.ts` — add a vN→vN+1 step, bump `MODEL_CONFIG_VERSION`                                                |

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
  (default `'none'`), `kbAutoMaintain` (default `true`) and `theme`
  (`dark` / `light` / `system`, default `dark`); `save-settings` merges a **partial** patch over the stored settings
  (`mergeAppSettings`), so a caller sends only the fields it changes.
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
  `saveModelConfig` validates before writing and returns `{ ok, error }`. Keys are sealed on
  write and opened on load; the renderer gets `redactModelConfig` output (`hasApiKey`, no key)
  and main restores the stored key via `withStoredApiKey`. An empty
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
  atomically (temp file + rename); `deleteConversation` removes both inside the per-id write chain,
  so an autosave queued before the delete cannot recreate the record. `listConversations`,
  `searchConversations` and `listUnfedConversations` read sidecars and **backfill** a missing or
  corrupt sidecar from the body inside the write chain. Ids are validated against
  `SAFE_CONVERSATION_ID` before touching the filesystem.
  Writes for one id are serialized by a per-id chain; use `saveConversation` for whole-record
  writes and `mutateConversation(id, mutate)` for read-modify-write (KB-fed marking/reset). A
  mutation runs inside the same chain, so it cannot overwrite a newer autosave with the body it
  read first; returning `false` from the mutator cancels the write.
  `searchConversations` scans chat records by title and flattened turn and expansion content, ranking title
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
  correct roleId (`'chat'` or `'lookup'`; anything else falls back to chat) for
  `callProviderStream`. Payloads are validated in `streaming.ts`. Chunks are batched deltas; the
  terminal message carries the full text. A cancelled send ends with
  `chat-response { text: partial, cancelled: true }`, a cancelled expand with
  `chat-expand-chunk { text: partial, done: true, cancelled: true }`. The renderer leaves a
  settled request out of its request book, so late chunks for it are no-ops.
- **The document base is the only personalization.** There is no learned prompt or keyword list:
  chat and lookup learn about the user solely through the memory instructions and tools. A model
  without tool support therefore gets no personalization, except in expand, which then gets the auto-loaded notes as text. Learning preferences live in the root
  `index-learning.md`, which the curator maintains. `migrateLegacyKbPrompt` moves an older
  install's `kb/prompt.txt` there once at startup and renames the old file `prompt.migrated.txt`.
- **A document base about the user lives in `{userData}/memories/`** (`~/.config/delta-ai/memories/` on Linux). It is a nested tree of
  markdown files managed through the `memory_*` function tools (ls, cat, grep, write, edit, mkdir, mv,
  rm). These are not a real shell and must not become one: the model can receive untrusted screen
  text, so `memory/store.ts` implements each command in JS, confines every path to the root, refuses
  `..`, absolute paths and symlinks, and only touches `.md` files.
  - **Writers.** The background curator is the primary writer: `runKbAnalysis` runs one tool pass per
    conversation through the `kb-maintenance` role (`KB_MEMORY_SYSTEM_PROMPT`, deliberately
    aggressive), so a failed pass leaves the conversation unfed. Chat and lookup hold the same tools,
    but their prompt limits writes to explicit requests. Expand holds them too, as a follow-up does;
    `withAutoLoadedMemories` gives it the auto-loaded files as text only when the model has no tools.
    The curator also learns from expansions, via the selected passage and typed question in
    `buildSingleMaterial`.
  - **Auto-loading.** A file directly in the root whose name starts with `index` is injected into
    every memory prompt (8k chars per file, 16k total). No other file ever is, including a nested
    `index.md`: the rest of the tree is listed by path and read on demand. The prompts state this rule
    to the agent (`AUTO_LOADED_MEMORY_PREFIX`), and still recommend subdirectory indexes and collection files.
  - **Transport.** Tools and instructions reach `callProviderStream` as one `AgentTools` value on the
    same OpenAI-compatible route for every provider, so they are not provider tools. The loop stops
    at `maxSteps` (10, curator 25), and the last step must answer in text. A model the catalog marks
    as tool-less gets no tools; for an unknown model, a 400/404/422 before any output retries once
    without tools or their instructions. The curator sets `toolsRequired` instead: either case fails
    the pass and surfaces in `kb-status`, so a conversation is never marked fed with nothing written.
  - **Indicator.** A successful mutation broadcasts `memory-updated` to every window, and
    `MemoryIndicator` shows a transient pill. It is not on a turn because curator writes happen with
    no reply on screen.
- **A canvas is a conversation record with a layout.** `source: 'canvas'` plus `state.canvas`
  (`CanvasLayout`: cards and viewport), so storage, atomic writes and the curator need nothing new,
  and history and search stay chat-only. `state.turns` is a pool rather than a line: a card's history
  is `turnsThroughCard`, following `parentId`, so branches do not see each other. `normalizeCanvasLayout`
  distrusts the stored layout at load. An emptied canvas is deleted from disk.
- **Select is the default tool; a press decides by where it lands.** On a title it selects and can
  drag, in a body it selects text (a plain click selects the card, `handleCardClick`), on empty space it
  starts a marquee. A press that never travels `DRAG_START_PX` is a click. Double clicks are counted by
  hand (`isDoublePress`), because a claimed press captures the pointer and `dblclick` would reach the
  surface; the press that opens an editor must then cancel its own `mousedown`, or focus leaves the
  editor and closes it. The selection bar sits at the bottom because at the top it covered the title
  bars of the cards a Fit puts there.
- **A note is a card, a frame and a connection are not.** A note (`kind: 'note'`) stands on the plane
  like any card, so it snaps, joins and may not overlap, but holds no turn, so it continues no session
  (`continuationCandidates`) and curator passes never see it: note edits save with `touchContent: false`.
  A blank note never reaches the document (`noteDraft`). Frames sit under the cards and are no obstacle;
  only the title and corner take the pointer, so a marquee can start inside one. Membership is
  geometric and read when a frame moves. Removing a frame keeps its cards. `layout.frames` and
  `layout.links` are always arrays after `normalizeCanvasLayout`; older records read as empty.
- **Undo is patches, because answers keep streaming.** `recorded(label, action)` in `useCanvas` diffs
  by identity around one user action, so everything that edits the document must copy only what it
  edits. `applyCanvasPatch` puts back only what that action changed. Moving, resizing, colour, notes,
  frames, connections, duplicate and delete are undoable; asking, expanding and height fitting are
  not recorded. Regenerate and edit are not either, and their confirmation still says so. The stacks are
  per open canvas and in memory only. The double confirmation for taking other cards along stays, with
  wording that says Ctrl+Z works; deleting only what was explicitly selected asks nothing.
- **Asking about a selection is material, not history.** `card.sources` names the cards, and
  `withCanvasSources` puts their text (`SOURCE_TEXT_LIMIT` each) in the newest user message at request
  time only, like `withCanvasFit`, so stored turns never carry it. A single top-level answer continues
  instead, as its history is better context. `askedAboutRelations` draws the dashed lines for this, except
  from the card it continues, which already has its mark from `canvasContinuations`.
- **A link can send context, and that context belongs to the branch.** `CanvasLink.context` is
  `'card'` (the start's text) or `'branch'` (everything through the start); without it a link is only
  a drawing. `requestContext` walks the sending card's session (`sessionCardIds`), so a link reaches
  every later card on that branch and regenerating, but not sibling branches. It is read at request
  time and put in the newest user message (`withCanvasContext`), so turns never carry it and editing a
  note changes the next request. It stops at one hop, so links cannot cycle. Turns already in the
  history or sent by another link appear once, and the text is capped (`TOTAL_TEXT_LIMIT`) because the
  context budget never trims the newest message. Expansions on the branch receive it too. Links
  added after an answer do not change that answer until it is regenerated.
- **The composer attaches context before anything exists.** `Draft.context` holds pending links;
  `ask` turns them into real ones. Dragging a card, a note or a card's `+` onto the draft links it
  (`overDraft`, `linkToDraft`), and everything selected goes along; a dragged card then returns to
  where it stood. A text box is an ordinary note dragged there. Links further up the branch show as
  inherited chips. A draft cannot send while a linked answer is streaming.
- **A `+` is a click or a drag.** It claims the press (`extend` gesture), so its `onClick` is only the
  keyboard's. A click continues on that side. Let go in open space and an `unheld` draw follows the
  pointer from there until the next click (`handleSizingPress` takes that press before a card's own
  handlers), and the draft continues that card wherever it stands; no travel gives the default size.
- **A draft resizes from the corner away from its parent** (`draftGrowth`, `resizeDraftRect`), by
  drag or Alt+arrows. Growth stops at what stands in the way, since a draft has nothing to push and
  no card has moved yet. `estimateWords` follows, so this is how the answer's length is chosen.
- **Far out, a card is its title.** Below `FAR_ZOOM` the surface gets `data-far` at rest, and
  `.canvas-card-lod` covers the card with its title scaled against the zoom. The header and body are
  `visibility: hidden`, never `display: none`, because a card finishing out there still measures its
  answer. `.canvas-card-body` has `scrollbar-gutter: stable`: without it a fitted answer can wrap one
  line longer under the scrollbar it had, and so keep the scrollbar.
- **Collapsing goes through `resizeCard`** (`setCardCollapsed`), so what is joined below follows.
  `collapsedFrom` is the height to return to, and anything sizing from a card (`openCardSize`) must use
  that, not `rect.h`. Inset cards on a collapsed host are not rendered (`hiddenInsetIds`). Regenerate
  reopens first, as the rectangle decides the length.
- **The plane moves outside React.** Wheel zoom, wheel pan and drag pan go through
  `createViewportMotion`: frames ease with `chaseViewport` and are painted directly, with the layer
  promoted (`data-moving`), and `setViewport` runs once the view rests. So `viewportRef` is the live
  value and `viewport` can lag; `claimPress` and `glideTo` call `settle()` before relying on it. The
  transform and grid are never React style props (`paintViewport`), and `--canvas-zoom` changes only
  at rest because every card inherits it.
- **A rectangle decides the answer's length.** `estimateWords(rect, captionChars)` mirrors the card
  typography in `canvas.css`; change them together. `withCanvasFit` appends the size to the newest
  user message at request time only, so turns never store it, and the note overrides the system
  prompt's concision and expand's four-sentence limit.
- **A drag moves what was chosen; touching cards are joined when resizing or with Shift.** A plain drag
  or nudge moves the selection and anything inset on it (`detachedCardIds`). Shift+drag moves everything
  joined by a shared side (`movingCardIds`), and align, tidy and duplicate still treat joined cards as one
  block. Since Shift also adds to a selection, a Shift press only toggles once it is let go without
  travelling (`shiftPress`). Resizing (`resizeCard`) carries the cards beyond the moved edge both
  ways, plus anything joined only through them (`edgeFollowers`); a card also joined by another route
  keeps its place. Growing pushes whatever else is in the way; shrinking stops where a follower can come
  back no further (`roomBehind`), so a gesture is limited rather than refused.
- **A finished answer then fits its card's height, never its width.** `useCanvas` marks a card when
  its answer completes normally (not stopped, not failed), and `CanvasBoard` measures it on screen
  and applies `fitCardHeight`, so an answer that finished in another view fits on return. It resizes
  as `resizeCard` does. A body still scrolls when the card
  cannot change: an inset card capped by its host (refitted when dragged out), or a card that
  cannot shrink because what hangs below cannot follow.
- **Regenerate and Retry are one action sized by the card's current rectangle** (`regenerateCard`).
  Like chat it drops what came after: every card in `cascadeCardIds`. Anything that takes other cards
  along, delete included, confirms twice (`confirmCascade`); a card nothing depends on deletes at once.
- **Sides are sessions.** Drawing with a side against a card (`continuationParent`, snapped by
  `snapEdges`) continues it; anywhere else starts a new session. A rectangle touching several cards
  continues one only (`continuationCandidates`, newest first) and sends only that history; the
  drawing highlights it (`is-continued`) and the draft's "Continues" picker can switch to another
  candidate or to a new session. Alt+drag pulls a card off its parent and neighbours, bringing the descendants attached
  to it (`pulledOutCardIds`; one reached by a link stays) and leaving its session history (`parentId`) intact; anything standing on the plane may not overlap, and a
  refused drop turns everything that would have moved red (`refusedIds`) and springs back through the
  cards' own transform transition.
- **The draft is the canvas's composer, and the viewport follows it like a pinned chat.** Sending
  closes it; the next one opens on request (Enter continues the card just sent, or a card's `+`), kept
  against its parent through `Draft.side` as the card grows or moves; it cannot send while the answer
  it continues is streaming or failed.
  `followRef` keeps the draft and its parent on screen (or just the draft, under the answer's newest
  lines, when both do not fit); any manual pan, wheel or zoom lets go, typing in the draft or "Back
  to your question" re-pins. A streaming card body sticks to its newest line (`nextPinned`).
- **A session always shows between its cards.** `canvasContinuations` gives each continuation, and each expansion touching its host, one
  mark pointing from the earlier card to the later one: on the boundary they share (`seam`) when they
  touch, otherwise a link. Touching alone joins cards but says nothing about history, so a boundary
  with no mark is two cards merely placed together, and a card joined to its parent only through a
  third card still gets a link. A `+` shows wherever it has open space to sit (`continueHandleBlocked`), since a drag can place the next message even when a click has no room beside the card.
- **Canvas is keyboard-drivable.** Cards are focusable: arrows move to `nearestCardInDirection`,
  Enter/Shift+Enter continue below/right, B goes back (`sourceCardId`; an expansion returns to its
  term, flashed and scrolled into its card), E edits, Delete deletes, PgUp/PgDn scroll. With no card
  focused, Enter opens the composer, N a new session, arrows pan, +/−/0 zoom, `?` lists them all.
  Clicking a link travels to its farther end. Focus never scrolls the plane: drafts and editors
  focus with `preventScroll`, and the surface resets any scroll a focus causes; only the viewport
  moves it.
- **Canvas gestures cancel `mousedown`, never `pointerdown`.** Cancelling `pointerdown` suppresses the
  `mousedown` that `ContextMenu` and `ExpandPrompt` use to notice an outside click, so they would stay
  open. `claimPress` marks the press, and `handleSurfaceMouseDown` cancels it and releases focus.
- **A right drag pans and a right click opens a menu, on every platform.** `contextmenu` fires on press
  on Linux and macOS and on release on Windows, so `createRightDrag` (`views/canvas/right-drag.ts`) holds it from a capture handler and
  decides at release: after a drag it is dropped, otherwise it is dispatched again on what was pressed,
  so the card, frame, link, text and plane menus need no knowledge of this. The pointer is captured only
  once the press becomes a drag, since capture would retarget the menu.
- **Canvas expansions are `ExpansionNode`s shown as cards.** `useExpansionContextMenu` chooses the
  term, then `CanvasView` holds it as `Placing` until a rectangle is drawn or clicked. Inside the
  host the card is `inset`; dragged clear (`resolveMove`) it stands alone and `CanvasLinks` draws
  the link, under the cards and faintly over them so it never strikes through text. Offsets are
  measured relative to the scaled `.canvas-card-surface`, which stays correct mid-animation.
  `folded` has no meaning on a canvas.
- **The map follows the viewport without rendering.** `paintViewport` calls `CanvasMinimap.paint`, which
  sets the SVG `viewBox` and view rectangle directly. The `viewBox` is held still during a drag on the
  map, or the map would slide from under the pointer. Whether it is open is the one thing kept in
  `localStorage`, as a per-viewer convenience.
- **The curator sees the conversation's shape, not its storage order.** `buildSingleMaterial` asks
  `conversationExchanges` for question/answer pairs with a `parentId` (a chat is one line, a canvas
  follows its cards), then `splitIntoThreads` cuts them at forks, so shared history appears once and
  each branch says which thread it continues. A single line has no thread labels. Anything that gains
  branches, such as a future branching chat, only needs to report its exchanges there.
- **Chat and lookup are one assistant.** Only the window differs: same memory tools, curation and
  context budget, one `DELTA_SYSTEM_PROMPT` (`LOOKUP_WINDOW_NOTE` adds only a length limit), plus a
  one-way transfer. `source` records where a conversation started; history lists still show only
  chats. The curator gets a lookup's turns and expansions but not its raw `state.context`.
- **Sends are context-budgeted.** `applyContextBudget(messages, role)` drops the oldest non-system messages until the estimate
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
  `createdAt` is set once on the first send. Renderer autosaves cannot set `kbFed` (main merges
  it from the existing file), but a newer `updatedAt` clears it, so turns and expansions added after
  a curator pass are curated too. `markConversationKbFed(id, curatedUpdatedAt)` refuses to mark a
  record that changed during the pass. A stop after output keeps the partial text and saves it; a stop
  before the first token saves only the user turn. Empty conversations are never saved. Error
  turns are persisted for Retry. A failed save resolves to `{ ok: false, error }` (never rejects): the
  chat shows it above the composer until the next successful save, and opening another
  conversation stays on the unsaved one when its pre-switch save fails.
- **Stop/retry/regenerate live in the chat window**: while loading, the composer send button
  becomes a Stop button wired to `stop()` (Escape triggers it too, unless a menu, prompt, search
  or editor claims the key first), which cancels in-flight expands first and then the
  active send. An assistant turn with `error: true` renders Retry; `retry(turnId)` and
  `regenerate(turnId)` share `replaceAssistantTurn`, dropping that answer and everything after
  it, keeping the preceding user turn, and re-sending the serialized conversation. Regenerate is
  also offered on successful answers and confirms when later turns would be dropped.
  Editing a user message (`editMessage`) runs the same truncate-and-resend path
  (`truncateAndResend`): the edited turn and everything after it are replaced by the new text and
  a fresh answer; the UI confirms only when more than that one answer would be dropped.
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
- **App-level chat chrome.** `App.tsx` owns the Ctrl/Cmd+N (new chat, switches to Chat) and
  Ctrl/Cmd+K (search) listeners, the `ConversationSearch` modal and the composer draft, so they
  work from every view and the draft survives `Conversation` unmounting. The Home view lists the
  five most recent chats (`conversation-list`). Deleting the open conversation goes through the
  chat toolbar (`deleteConversation` in the hook detaches the meta first so no autosave follows);
  the search modal still refuses to delete the open chat.
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
  pass that curates at most 4 newest unfed conversations into the document base through the
  `kb-maintenance` role; a backlog continues every 45s, failures back off 2m → 30m, and
  `kb/state.json` persists pacing/error state. All runs (manual or automatic) share one queue,
  so writes never interleave. Nothing runs without a `kb-maintenance` model, and
  `settings.json → kbAutoMaintain` (default true, Settings → General) stops it. Status is pushed
  as `kb-status`; the Knowledge view renders it.
- **Markdown is rendered, never flattened for display.** `Markdown.tsx` runs
  `remark-parse` + `remark-gfm` → `mdast-util-to-hast` → `hast-util-to-jsx-runtime`. Every
  mdast text node becomes `<span data-src={absoluteOffset}>text</span>`: that span _is_ the
  DOM↔source map. Two component maps: block mode (real `p`, `ul`, `ol`, `li`, `pre`,
  `table`, `blockquote`, `h1-3`) for turn content, and inline mode (only `span`/`code`/
  `strong`/`em`/`del`/`a`, with `md-p`/`md-list`/`md-li`/`md-pre`/… classes) inside an
  expansion frame, whose host is a `<span>`. `flattenMarkdown` remains only for titles and
  search.
- **Links open in the system browser.** `Anchor` renders `target="_blank"` and does not intercept
  the click: `setWindowOpenHandler` in `window-guards.ts` hands http(s) URLs to `shell.openExternal`.
  The renderer allowlist must match `isSafeExternalUrl`, so every other scheme (`mailto:` included)
  renders as plain text instead of a link that does nothing. The tooltip always shows the real URL,
  never a model-written title.
- **Fenced code is highlighted without touching offsets.** Fenced code never carried `data-src`
  and still does not, so it stays non-expandable. `highlightCode` only wraps text in `hljs-*`
  spans; the text is unchanged, so Copy stays exact. Blocks over 20k chars stay plain because
  highlighting re-runs on every streamed chunk.
- **Math must never move an offset.** `parseMarkdown` is the single entry point. `\(…\)` and
  `\[…\]` are rewritten to `$$` in place (both delimiters are two characters, code is skipped);
  `\[` counts only on its own line, so an escaped citation like `\[1\]` stays text. Prose dollars
  ("$5 and $10", Pandoc's rule) are demoted back to merged text nodes. A formula has no `data-src`,
  so it cannot be an expansion target. `electron.vite.config.ts` never inlines fonts, because the CSP
  has no `data:` in `font-src`. KaTeX runs with `trust: false`; `MathFormula` is the only
  `dangerouslySetInnerHTML` in the renderer, so keep that option.
- **Theme is `nativeTheme.themeSource`, not renderer state.** `applyAppSettings` sets it and CSS
  follows `prefers-color-scheme`: only the tokens in `base.css` differ, every open window restyles
  live, a new one paints correctly from its first frame, and there is no theme IPC. Hardcoded colours
  in a surface stylesheet break this, so use a token.
- **Image attachments live inline on the user turn** (`Turn.attachments`, base64 in `{id}.json`, never
  in the sidecar). The chat composer and the chat window's `ExpandPrompt` are the entry points (picker, paste, drop), and
  an expansion keeps its images on `ExpansionNode.attachments`; the lookup popup's paste still means OCR. The renderer re-encodes to a JPEG under 1568px, which also strips EXIF, and
  `ProviderMessage.images` carries them to `provider.ts`, where they become SDK `file` parts on the one
  OpenAI-compatible route. `chat-send` and `chat-expand` run `fitImagesToSupport`: on a model the catalog says is
  text-only, images in the message being sent are refused and earlier ones become `IMAGE_OMITTED_NOTE`,
  so a model switch cannot strand a chat. Unknown models are sent as-is and the provider decides. Each
  image counts as `IMAGE_TOKEN_ESTIMATE` in the context budget. KB analysis, search and
  titles use text only; export writes a `_[Image: name]_` line.
- **Selections are mapped by offset, never by string search.** `useExpansionContextMenu`
  resolves each Range endpoint to its nearest `[data-src]` leaf plus the character offset (or the
  `data-atom-start`/`-end` of a code block or formula, which have no per-character mapping),
  refusing when the endpoints live in different scopes (turn vs. frame). `anchoredRange` then gives
  the range an expansion would take: inside one text node as selected (`text`); a run of siblings
  in one phrasing parent, with an edge inside bold or a link widened over that element (`inline`);
  or one whole code block, formula or inline code span (`atom`). It refuses a selection across
  blocks or table cells, and one cutting a text node whose rendered text is not its source slice
  (escapes, quote markers), where DOM offsets would be wrong. `validateInsertion` must accept it
  too: non-empty, in bounds, not crossing a block boundary (`atomic` targets skip this line-based
  check, as a code block may hold blank lines), and not overlapping an existing expansion (nesting
  must target the parent frame explicitly). No `Range` objects survive into React state.
- **`originalText` may hold markdown.** A pill or frame header renders it with
  `<Markdown anchored={false}>`, which omits `data-src`/`data-atom-*`: offsets there would be
  relative to the snippet, so it must never look like a selection target. Code and formulas stay
  visible above their answer (`frame-source`); plain words are replaced by it as before.
- **A range can hold several expansions and shows one at a time.** The exact same range is not a
  conflict in `validateInsertion`; any partial overlap still is. `insertExpansion` and
  `setExpansionFolded(…, false)` fold the others on that range, `prepareMarkdownTree` splices only
  `activeExpansion`, and `Markdown` hands `renderExpansion` the whole group. With several answers,
  the pill and the frame's "N answers" button open a list (`ContextMenu` `items`). Right-clicking a
  pill or pressing "Ask…" adds another answer; regenerate replaces one in place.
- **Regenerating or removing a frame stops its streams first.** `discardExpandsForExpansions` drops
  the node and its subtree from the request book, and `restartExpansion` clears `children` with the
  answer, since their offsets point into the old text. The UI confirms when nested frames would go.
- **An expansion is a follow-up that branches from its turn, plus its own features.**
  `buildExpandRequest` sends exactly what a follow-up at that point would (`serializeForChat`: system
  prompt, screen context, every earlier turn with its images), then the turn, each ancestor of a nested
  selection as a question/answer pair, and the instruction. Keep that prefix identical, because it is what
  a provider's prompt cache reuses. `chat-expand` matches `chat-send` in main too: `fitImagesToSupport`,
  `memoryAgentFor`, `applyContextBudget`. Being a branch, it never enters the history of later turns or of
  sibling expansions. Its own features are the anchor, the define/explain instruction
  (`isTermSelection`) and the short default length. Anything added to follow-ups should reach it as well.
- **Expanding has several entry points, all through `submit`.** The context menu, the selection
  bar, Ctrl/Cmd+E (Expand) and Ctrl/Cmd+Shift+E (Expand on…) resolve and validate the same way.
  `EXPAND_INTENTS` store their text in `prompt`, so frames, export and the curator treat them as a
  typed question.
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
  right-click position, or below the frame for "Ask…". Edit on a frame or card changes the question and answers again in place (`editExpansion`, `editCard`),
  dropping nested expansions like Regenerate; blanking it returns to the plain instruction. On submit, the prompt text (defaulting to
  `EXPAND_DEFAULT_PROMPT` if empty) replaces the define/explain instruction via
  `buildExpandPromptedInstruction` in `prompts.ts`, and a non-blank prompt is shown on the frame;
  a folded pill keeps it only as a tooltip.

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
