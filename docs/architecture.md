# Delta AI — Architecture

Delta AI is an Electron desktop app with two windows that share one renderer bundle:

- **Main window** — sidebar with Home, Chat, Knowledge Base, Look-Up Guide and Settings.
- **Look-Up popup** — a frameless, always-on-top 420×320 window created near the cursor by the
  global hotkey. It grows to 840×640 on the first ask and then stays open on blur.

Both windows talk to the same main process. Everything the app knows about the user stays in
`{userData}`; the only outbound traffic is the BYOK AI request itself.

`AGENTS.md` is the operational companion to this document: commands, conventions, and a
"what to touch when" table. Keep the two in sync when the shape changes.

---

## 1. Process and module map

```
┌─ renderer ─────────────────────┐   ┌─ preload ─────┐   ┌─ main ──────────────────────────┐
│ Root.tsx (?role=lookup)        │   │ contextBridge │   │ index.ts  lifecycle + IPC       │
│ ├ App.tsx      sidebar + views │──▶│ window.api.*  │──▶│ provider.ts  AI dispatch        │
│ └ LookupApp.tsx  popup         │   │ (typed in     │   │ config.ts    settings + hotkey  │
│ hooks/useChatStreaming.ts      │   │  index.d.ts)  │   │ conversations.ts  persistence   │
│ hooks/useExpansionContextMenu  │   └───────────────┘   │ lookup/   capture, OCR, popup   │
└────────────────────────────────┘                       │ kb/       analysis + storage    │
                                                         │ services/ Wayland portals       │
                                                         └─────────────────────────────────┘
                        shared/ (pure TypeScript, imported by both sides)
                        models.ts · conversation.ts · rich-text.ts · prompts.ts · expand-prompt.ts
```

| Module                                                            | Responsibility                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/shared/models.ts`                                            | Provider/role registries, `Connection`, `RoleAssignment`, `ModelConfig`, `ProviderMessage`, keyword types                                                                                                                                                                                                                                                    |
| `src/shared/conversation.ts`                                      | `ConversationState` / `Turn` / `ConversationRecord`: a turn is markdown `content` plus `expansions: ExpansionNode[]`. `persistableTurns`, `serializeForChat`, `buildConversationTitle`, and `migrateConversationRecord` (the load-time legacy boundary)                                                                                                      |
| `src/shared/rich-text.ts`                                         | The rich-text model and all pure operations: `ExpansionNode` (absolute `[start,end)` anchors, markdown `answer`, `status`, `folded`, nested `children`), `validateInsertion`, `insertExpansion(InTurns)`, `updateExpansion`, `setExpansionFolded`, `findExpansionIn*`, `maxExpansionId`, `expansionMessageInput`, `flattenMarkdown`, `migrateLegacySegments` |
| `src/shared/prompts.ts`                                           | Every LLM-facing string: system prompts, screen-context template, lookup default, expand instructions, KB prompts                                                                                                                                                                                                                                            |
| `src/shared/expand-prompt.ts`                                     | `buildExpandMessages({ answer, selection, prompt? })`                                                                                                                                                                                                                                                                                                        |
| `src/shared/context-budget.ts`                                    | Pure budgeting: `estimateTokens` (4 chars/token), `budgetFor` (85% of the window minus a capped output reserve, floor 1024), `trimMessages` (drops the oldest non-system messages, never the last)                                                                                                                                                           |
| `src/main/index.ts`                                               | App lifecycle, main window, tray, streaming IPC (`chat-send`, `chat-expand`, `chat-cancel`) with `safeSend` + owner-scoped cancellation, lookup grow/transfer, conversation CRUD + search/export channels                                                                                                                                                    |
| `src/main/context-budget.ts`                                      | `applyContextBudget(messages, role)`: trims chat sends using the cached models.dev entry (`getCachedModel`, no network); returns the input untouched on any missing input or error                                                                                                                                                                           |
| `src/main/conversation-export.ts`                                 | `renderConversationMarkdown` (turns + quoted expansions, each reply nested one quote level deeper) and `exportConversationToFile` (save dialog, atomic write, `{ok,path}` / `{ok:false,error}`)                                                                                                                                                              |
| `src/main/transfer.ts`                                            | `prepareTransferredState`: finalizes in-flight frames and folds screen context into a user turn before persist/forward                                                                                                                                                                                                                                       |
| `src/main/provider.ts`                                            | The single dispatch point: role → connection → backend. `callProviderStream(…, signal?)` is the only primitive; `callProvider` drains it; an abort ends the stream                                                                                                                                                                                           |
| `src/main/services/atomic-file.ts`                                | `writeFileAtomic[Sync]`: sibling temp file + rename, so interrupted writes never leave truncated JSON/text                                                                                                                                                                                                                                                   |
| `src/main/config.ts`                                              | `providers.json` / `settings.json` I/O, hotkey registration (X11 + portal), register-before-save, startup fallback, Wayland detection                                                                                                                                                                                                                        |
| `src/main/models/config-schema.ts`                                | Zod validation, schema migrations (v1→v3), repair of dangling roles/unknown providers; empty `connectionId` → `null` (unassigned)                                                                                                                                                                                                                            |
| `src/main/services/model-catalog.ts`                              | models.dev catalog fetch, 24h disk cache, offline fallback, `load-model-catalog` IPC                                                                                                                                                                                                                                                                         |
| `src/shared/model-catalog.ts`                                     | `CatalogModel`/`ModelCatalog` types, provider-id mapping, flattening and formatting helpers                                                                                                                                                                                                                                                                  |
| `src/main/conversations.ts`                                       | Conversation record CRUD (atomic) under `{userData}/conversations/`: body + `{id}.meta.json` sidecar, per-id write chain, `saveConversation` / `mutateConversation` (read-modify-write in the same chain), title + content search, KB-fed marking, `resetKbFedFlags`, save notifications                                                                     |
| `src/main/lookup/lookup.ts`                                       | Hotkey entry point: clipboard → OCR fallback → popup session                                                                                                                                                                                                                                                                                                 |
| `src/main/lookup/capture.ts`                                      | Screen capture (portal-first on KDE Wayland) and the single serialized tesseract.js worker                                                                                                                                                                                                                                                                   |
| `src/main/lookup/window.ts`                                       | Popup `BrowserWindow`, `?role=lookup` load, grow animation, per-window channels, one-time OCR IPC handler                                                                                                                                                                                                                                                    |
| `src/main/lookup/state.ts`                                        | `LookupSession`, `notifySessionState`, `applyOcrResult`, liveness helpers                                                                                                                                                                                                                                                                                    |
| `src/main/lookup/handlers.ts`                                     | Paste-text / paste-image handlers                                                                                                                                                                                                                                                                                                                            |
| `src/main/kb/analysis.ts`                                         | Structured conversation material + analysis/keyword message construction                                                                                                                                                                                                                                                                                     |
| `src/main/kb/keywords.ts`                                         | Pure keyword parsing, merging, per-category trimming                                                                                                                                                                                                                                                                                                         |
| `src/main/kb/run.ts`                                              | `runKbAnalysis(metas, { markFed, signal })`: folds conversations into the prompt and keywords, persisting per conversation, skipping empty/look-up records                                                                                                                                                                                                   |
| `src/main/kb/schedule.ts`                                         | Pure pacing policy: debounce, batch size, backlog interval, exponential retry, startup delay                                                                                                                                                                                                                                                                 |
| `src/main/kb/maintenance.ts`                                      | Automatic maintenance loop: save/config subscriptions, single-flight queue, bounded passes, backoff, `kb-status` fan-out, reset that aborts a running pass                                                                                                                                                                                                   |
| `src/main/kb/store.ts`                                            | `{userData}/kb/prompt.txt`, `keywords.json`, `state.json` I/O (atomic); `resetKb` deletes all three                                                                                                                                                                                                                                                          |
| `src/main/kb/handlers.ts`                                         | `kb-load-prompt`, `kb-save-prompt`, `kb-reset`, `kb-get-status`, manual `kb-analyze`/`kb-reanalyze` (queued with the automatic loop)                                                                                                                                                                                                                         |
| `src/main/services/global-shortcut.ts`                            | `org.freedesktop.portal.GlobalShortcuts` over D-Bus                                                                                                                                                                                                                                                                                                          |
| `src/main/services/screen-capture.ts`                             | `org.freedesktop.portal.Screenshot` over D-Bus (silent capture)                                                                                                                                                                                                                                                                                              |
| `src/renderer/src/hooks/useChatStreaming.ts`                      | Owns `ConversationState` and the request book; send/stop/retry/regenerate/rename/newChat/load actions; auto-saves through `hooks/chat/persistence.ts`                                                                                                                                                                                                        |
| `src/renderer/src/hooks/chat/requests.ts`                         | Pure request bookkeeping: pending ids with kind/turn/expansion, `activeSendId`, `settleRequest`, `discardExpands`/`discardExpandsForTurns`/`clearRequests`                                                                                                                                                                                                   |
| `src/renderer/src/hooks/chat/transport.ts`                        | `chat-*` subscriptions; every listener resolves its `requestId` first, so chunks for settled/cancelled ids are ignored                                                                                                                                                                                                                                       |
| `src/renderer/src/hooks/chat/persistence.ts`                      | Autosave: `saveConversationState` + the effect that flushes a requested snapshot; `touchContent` decides whether `updatedAt` moves                                                                                                                                                                                                                           |
| `src/renderer/src/components/conversation/ConversationSearch.tsx` | Ctrl/Cmd+K search modal: `conversation-search`, snippets, load/delete + delete-error banner                                                                                                                                                                                                                                                                  |
| `src/renderer/src/hooks/useExpansionContextMenu.ts`               | The right-click → selection/word → Expand pipeline, shared by both windows                                                                                                                                                                                                                                                                                   |

---

## 2. Call chains

### Chat send

1. `Conversation` composer → `useChatStreaming.send(text)`.
2. `serializeForChat(state, role)` builds the provider messages: the system prompt always, the
   screen-context preamble when `state.context` is non-empty, then every turn — assistant turns
   flagged `error: true` or containing only blank/whitespace are omitted, so neither error text
   nor in-flight placeholders are replayed. The look-up context source (`none` by default)
   decides whether a context is captured at all.
3. `window.api.chatSend({ messages, requestId, role })` → `chat-send` in `index.ts`.
4. Main validates the payload (`streaming.ts`: `parseProviderMessages`, `parseStreamRole` —
   only `chat`/`lookup` are reachable) and, for both roles, appends the KB personalization
   prompt to the system message (`withKbPrompt`) before dispatch.
5. For `role: 'chat'` only, `applyContextBudget(messages, 'chat')` drops the oldest non-system
   messages (never the last) until a 4-chars-per-token estimate fits `budgetFor` of the cached
   model's `contextWindow`/`maxOutput`. The catalog is read from the memory/disk cache only, and
   every missing input fails open — trimming never drops a request.
6. `callProviderStream(messages, roleId, controller.signal)` resolves the role assignment and
   streams deltas. Main keeps `{controller, senderId}` in `activeStreams`, keyed by `requestId`.
7. Tokens are coalesced by `createChunkBatcher` (one message per 32 ms) and sent as
   `chat-chunk { requestId, delta }` through `safeSend` (a destroyed sender is a no-op); the
   renderer appends the delta to `turn.content` and re-renders markdown live
   (`components/conversation/Markdown.tsx`). `chat-response` carries the **full** text, replaces
   whatever was streamed, closes the turn, and the conversation is saved. Expand streams the same
   way (`chat-expand-chunk { delta }`, then `{ text, done }`). There is no tokenize step: `content` is the only copy of the text.
8. The chat composer's Stop button sends `chat-cancel(requestId)`. Only the webContents that
   started the request may cancel it; main aborts the provider request and closes with
   `chat-response { text: partial, cancelled: true }`. The renderer drops the id from its request
   book before cancelling, drops an empty assistant turn if no token arrived, and otherwise
   keeps/saves the partial text. Retry (shown on an error turn) and Regenerate drop that answer
   and everything after it, then re-send the remaining conversation.

### Inline expand

1. Every markdown text node is rendered as `<span data-src={absoluteOffset}>` (`Markdown.tsx`).
   `useExpansionContextMenu` resolves the selection (or `caretRangeFromPoint` + `expand('word')`)
   to two such leaves and computes absolute `{start, end}` offsets in the enclosing source:
   `turn.content` at the top level, or one expansion's `answer` when the anchors sit inside its
   `data-expansion-id` frame. Endpoints in different scopes are refused. No string search and no
   `Range` survives into React state.
2. A range is expandable only when it lies inside a single mdast text node
   (`lib/markdown.ts: isAnchoredRange`) and `validateInsertion` (`shared/rich-text.ts`) accepts
   it: in bounds, non-empty, no block boundary, and no overlap with an existing expansion.
   The menu's disabled state and `expand()` use the same checks.
3. `useChatStreaming.expand` calls `expansionMessageInput` (current markdown answer + selected
   excerpt), inserts a `status: 'loading'` node via `insertExpansionInTurns`, then sends
   `chat-expand` with `buildExpandMessages`.
4. `chat-expand-chunk` carries `{ text, done? }` or `{ error }`; a cancelled expand ends with
   `{ text: partial, done: true, cancelled: true }`. The handler patches `answer` with the
   cumulative text, flips `status` to `'done'` on completion and to `'error'` with the message on
   failure, and the conversation is saved on completion. Assigning the cumulative text means a
   loading→done transition can never drop streamed output.
5. Expands are cancellable and never outlive their turn. `stop`, `newChat`, `loadConversation`
   and a conversation transfer drop every pending expand (`discardExpands`); `retry`/`regenerate`
   drop only expands attached to the turns being removed (`discardExpandsForTurns`). The id is
   removed from the request book before `chatCancel`, so a late chunk is a no-op rather than a
   write to a frame that no longer exists. When it actually dropped expands, `stop` also
   finalises the remaining loading frames so the UI is not left waiting on them.
6. Expansion answers render with the same pipeline in **inline mode**: block constructs become
   `<span class="md-p">`/`md-li`/`md-pre`/… so nothing invalid nests inside the frame `<span>`.
   Nested frames anchor into the parent `answer`; their offsets are relative to it.

### Look-up hotkey

1. `registerHotkey` fires `handleHotkeyPressed` (portal signal on Wayland, `globalShortcut` on X11).
2. In `none` mode (the default): create the popup without capturing anything and publish an
   empty ready state, so the Ask field is immediately usable.
3. In `clipboard` mode: `wl-paste` text → clipboard image → OCR; anything found becomes the
   context. An empty clipboard falls back to the fullscreen capture path.
4. In `fullscreen-ocr` mode: capture the display under the cursor, run OCR, publish the text.
5. Every result goes through `applyOcrResult`, which drops stale jobs by `ocrToken` and a dead
   window by `isSessionAlive`. `notifySessionState` also stores `pendingState`, so a popup whose
   renderer was not listening yet can replay the latest context via the `lookup-ready`
   handshake.
6. `serializeForChat` prepends the captured context only when it is non-empty, so `none` mode
   (and an empty clipboard/OCR result) sends just the system prompt and turns. The `summarize`
   default applies only when a context exists; Ctrl+V can still fill the panel manually.

### Look-up → chat transfer

`lookup-transfer` marshals the whole `ConversationState`. `prepareTransferredState` runs once:
it converts any `status: 'loading'` frame into a recoverable error (so a transfer during
streaming never persists or forwards transport state) and turns the context into a user turn
(`buildScreenContextMessage`). Ordering matters:

1. Write the record once as `source: 'chat'`, preserving the original `createdAt`. A failed
   write sends `ai-error` to the popup and returns **without closing it**, so the chat can be
   retried instead of lost.
2. Close the popup only after the write succeeds.
3. Deliver `chat-replace-conversation` with
   `{ state, conversationId, conversationTitle, conversationCreatedAt }` — to the existing main
   window (shown/focused first), or to a newly created one once its renderer finishes loading.

The hook cancels every in-flight request first (their late chunks must not land on imported
turns), then seeds its conversation metadata from that `createdAt` so later saves update the same
record, and resets `expansionIdCounter` past the max imported id.

### Persistence and Knowledge Base

- Every config, KB and conversation write goes through `services/atomic-file.ts`, which writes
  a sibling temp file and renames it over the target.
- A conversation is two files: `{id}.json` (the record) and `{id}.meta.json` (`ConversationMeta`:
  id, title, timestamps, source, `kbFed`, `turnCount`). Every successful write replaces both, so
  a list/search never has to parse bodies; a missing or corrupt sidecar is backfilled from the
  body inside the write chain. Deletion removes both files.
- Writes for one id run through one promise chain. `saveConversation(record)` writes the whole
  record; `mutateConversation(id, mutate)` reads, applies the mutator and writes in the same
  chain, so a KB-fed mark or reset cannot overwrite a newer autosave with a stale body. Returning
  `false` from the mutator skips the write. KB-fed marking and `resetKbFedFlags` use it.
- A rename is metadata-only: the title changes, `updatedAt` does not, so the recents order is
  stable. Fold/unfold/dismiss save without touching content recency for the same reason.
- Auto-save runs on response completion (including stopped/partial responses), errors, expand
  completion, fold and unfold. Turns pass through `persistableTurns()` before writing: blank
  assistant placeholders are dropped, and conversations with no persistable turns are not
  written. Error turns stay on disk but are omitted by `serializeForChat`, which also drops
  blank assistant placeholders.
- The learning profile maintains itself. `onConversationSaved` in `conversations.ts` notifies
  `kb/maintenance.ts` after every successful write; a 20s debounce after the last chat activity
  starts a bounded pass (`AUTO_BATCH_SIZE`, newest first, chat only). The pass folds each
  conversation into `prompt.txt` through the `kb-maintenance` role and marks it fed **per
  conversation**, so an interrupted run keeps its progress. Empty conversations and standalone
  look-ups are marked fed and skipped rather than retried forever.
- Pacing lives in `kb/schedule.ts`: 45s between passes while a backlog remains, 10-minute
  interval across restarts, exponential backoff (2m → 30m) after a failure. Every run is
  serialized through one queue shared with the manual buttons, so two passes never interleave
  writes. `kb/state.json` persists `lastRunAt`/`lastLearnedAt`/`lastError`/`failedAttempts`.
- Nothing runs without a `kb-maintenance` model assignment, and `settings.json` →
  `kbAutoMaintain` (default `true`, toggle in Settings → General) can stop it entirely.
  Saving settings or the model config re-checks the queue, so enabling the feature or assigning
  the model takes effect without waiting for the next chat.
- `kb-status` is pushed to every window on run start/finish and on request through
  `kb-get-status`; the Knowledge view renders it and adopts a newly learned prompt unless the
  user has unsaved edits, and the Home view refreshes its keyword tags when a pass finishes.
- `kb-analyze` runs the same pipeline over all unfed conversations; `kb-reanalyze(n)` reprocesses
  the `n` most recent without marking them fed.
- `kb-save-prompt` stores a user-edited prompt, which the next automatic pass treats as its
  baseline. `kb-reset` runs inside the maintenance queue, aborts an in-flight pass (and
  invalidates one still selecting its batch), deletes `prompt.txt`, `keywords.json` and
  `state.json`, and clears `kbFed` on chat records via `resetKbFedFlags()` (lookup records are
  untouched), so the retained history can be learned again.
- The resulting prompt is injected into every lookup request; keywords are stored for future use.

---

## 3. IPC surface

| Channel                                                     | Direction    | Purpose                                                         |
| ----------------------------------------------------------- | ------------ | --------------------------------------------------------------- |
| `chat-send` → `chat-chunk` / `chat-response` / `chat-error` | R → M, M → R | Streaming chat, correlated by `requestId`                       |
| `chat-cancel`                                               | R → M        | Abort a `chat-send`/`chat-expand` stream                        |
| `chat-expand` → `chat-expand-chunk`                         | R → M, M → R | Expansions (`done` / `error` / `cancelled` marks)               |
| `chat-replace-conversation`                                 | M → R        | Hydrate transferred state + id/title/createdAt                  |
| `lookup-trigger-grow` / `lookup-grow`                       | L → M, M → L | First-ask window growth                                         |
| `lookup-context` / `ai-error`                               | M → L        | Context status and capture/OCR errors                           |
| `lookup-paste-text` / `lookup-paste-image`                  | L → M        | Paste replaces the context                                      |
| `lookup-ocr-image`                                          | L ↔ M        | OCR a pasted image, returns `{ text, error? }`                  |
| `lookup-input-changed` / `lookup-close` / `lookup-ready`    | L → M        | Blur guard, close, replay pending context                       |
| `lookup-transfer`                                           | L → M        | Send the popup conversation to the chat window                  |
| `conversation-save` / `-load` / `-delete` / `-list`         | R ↔ M        | Conversation CRUD (atomic writes)                               |
| `conversation-search`                                       | R → M        | Search titles/content; adds `matchedIn`/`snippet`               |
| `conversation-list-unfed` / `-kb-fed`                       | R ↔ M        | KB integration                                                  |
| `conversation-export`                                       | R → M        | Save one conversation as markdown; cancel returns `'Canceled.'` |
| `load-settings` / `save-settings`                           | R ↔ M        | Save registers hotkey first (`{ success, hotkeyMode, error? }`) |
| `load-model-config` / `save-model-config`                   | R ↔ M        | Connections and role assignments                                |
| `load-model-catalog`                                        | R ↔ M        | models.dev model catalog (cached, force-refresh)                |
| `kb-load-prompt` / `kb-save-prompt` / `kb-reset`            | R ↔ M        | Prompt CRUD; reset also clears chat `kbFed`                     |
| `kb-analyze` / `kb-reanalyze`                               | R ↔ M        | Manual Knowledge Base maintenance                               |
| `kb-get-status` / `kb-status`                               | R ↔ M        | Automatic maintenance snapshot (invoke) + change push           |

`save-settings` registers the requested accelerator before persisting. If registration throws or
the desktop keeps the previous binding, it returns `{ success: false, error }` and does not
write the inactive shortcut; a key that only works in-app is saved with `hotkeyMode: 'local'`.
Startup registration is wrapped the same way — an invalid stored hotkey logs, falls back to
`DEFAULT_HOTKEY`, and never blocks window creation.

The Settings view has **no Save button**. It autosaves both files (`save-model-config` +
`save-settings`) after a 500 ms idle debounce, keeps a JSON snapshot of what is on disk so a
re-render is not mistaken for an edit, seeds that baseline after the initial load (loading must
never write back), flushes on unmount so leaving the view mid-typing cannot drop an edit, and
surfaces a failed save inline (`role="alert"`) instead of a native `alert()`.

---

## 4. On-disk format

```
{userData}/
  config/providers.json     ModelConfig (schemaVersion 2)
  config/settings.json      { hotkey, closeToTray, lookupContextMode, kbAutoMaintain }
  cache/models-dev.json     models.dev snapshot (24h TTL, offline fallback)
  conversations/{id}.json   ConversationRecord
  conversations/{id}.meta.json  ConversationMeta (list/search sidecar)
  kb/prompt.txt             personalization prompt (plain text)
  kb/keywords.json          CategorizedKeyword[]
  kb/state.json             { lastRunAt, lastLearnedAt, lastAnalyzed, lastError, failedAttempts }
  tesseract-cache/          tesseract.js traineddata
```

Config, KB and conversation files are written atomically (sibling temp file + rename, see
`services/atomic-file.ts`); a crash mid-write cannot leave a truncated file behind.

`providers.json`:

```json
{
  "schemaVersion": 2,
  "connections": {
    "conn_…": {
      "id": "conn_…",
      "label": "My Google key",
      "providerType": "google-ai-studio",
      "apiKey": "enc:v1:…",
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta"
    }
  },
  "roles": {
    "chat": { "connectionId": "conn_…", "model": "gemini-3.5-flash" },
    "lookup": { "connectionId": "conn_…", "model": "gemini-3.5-flash" },
    "kb-maintenance": { "connectionId": null, "model": "" }
  }
}
```

API keys are sealed with Electron `safeStorage` (OS keychain) behind an `enc:v1:` prefix by
`services/secret-store.ts`; a legacy plaintext key is read and resealed on the next load, and a
key that cannot be decrypted (locked keychain) is treated as missing without rewriting the file.
Without a keychain the key is stored as plaintext, as before. The renderer never receives a
stored key: `load-model-config` returns `hasApiKey` instead (`redactModelConfig`), and
`save-model-config` / `provider-test` / `provider-models` fill in the stored key for any
connection sent without one (`withStoredApiKey`). An explicit empty key removes it.

Provider types: `google-ai-studio`, `openai`, `openai-compatible`, `openrouter`, `ollama`.
`ollama` is the only provider that works without an API key.

Every provider is routed through the OpenAI-compatible wire format (`provider.ts: ROUTES`), so a
provider is a name plus a default base URL and nothing downstream branches on the provider type.
Google therefore uses `…/v1beta/openai`, not the native `generateContent` API. No provider tool is
injected: web-search grounding is not available, because the AI SDK only exposes it as
provider-specific tools (`google.tools.googleSearch`, `openai.tools.webSearch`), which is exactly
the special-casing this transport avoids.

---

## 5. Platform specifics

| Platform              | Hotkey                      | Screen capture                 | Clipboard          |
| --------------------- | --------------------------- | ------------------------------ | ------------------ |
| KDE Plasma Wayland    | XDG GlobalShortcuts portal  | Screenshot portal (silent)     | `wl-paste`         |
| Other Wayland         | XDG GlobalShortcuts portal  | `desktopCapturer.getSources()` | `wl-paste`         |
| X11 / macOS / Windows | `globalShortcut.register()` | `desktopCapturer.getSources()` | Electron clipboard |

Wayland caveats worth knowing:

- The portal may accept a shortcut but assign no trigger until the user approves it once in the
  desktop's Global Shortcuts settings (listed as "Delta AI"). `registerGlobalShortcutPortal`
  returns `false` in that case.
- Electron's clipboard reads the XWayland clipboard, which is often stale; `wl-paste` is tried
  first and Electron is the fallback.
- The popup position is clamped to the cursor display's work area; the compositor may still
  centre it instead of honouring the requested position.
- Capture is **full-screen**, not a cropped region, and OCR runs on the whole image; the cursor
  may report `(0, 0)` on Wayland without breaking the flow.

---

## 6. Build, test, package

```
electron.vite.config.ts
  main     → out/main/index.js
  preload  → out/preload/index.js
  renderer → out/renderer/ (both windows; ?role=lookup selects the popup)
```

| Command                                 | What it does                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run dev`                           | electron-vite dev server with HMR                                             |
| `npm run typecheck`                     | `tsc --noEmit` for the node and web projects                                  |
| `npm run lint`                          | ESLint                                                                        |
| `npm run test`                          | Vitest over `tests/**`                                                        |
| `npm run verify`                        | typecheck + lint + test + `prettier --check` — the gate to run before pushing |
| `npm run build`                         | typecheck, then `electron-vite build`                                         |
| `npm run build:linux` / `:mac` / `:win` | typecheck + build + electron-builder packaging                                |

Tests live in `tests/` and cover main/shared module logic in plain Node, mocking Electron, D-Bus,
or the config layer where needed: 26 files / 299 tests. Coverage includes `shared/rich-text`
(offset insertion inside markdown, refusal reasons, nested offsets, fold/find/max-id, legacy
segment migration), `shared/conversation` (`serializeForChat` omit rules, migration boundary),
`shared/context-budget` (estimate/budget/trim invariants), `shared/model-catalog`,
`main/kb/keywords`, `main/provider` (streaming, idle timeout after
partial output, external abort), `main/models/config-schema` (empty `connectionId` →
unassigned), `main/config-settings` (settings normalization), `main/conversations` (safe ids,
sidecar backfill, serialized writes, search ranking/snippets, `resetKbFedFlags`),
`main/conversation-export` (markdown rendering, save/cancel paths), `renderer/chat-requests`
(pure request book), `main/services/local-shortcut` (shifted keys), the
portal and model-catalog services, plus the supervisor-owned gates in `tests/acceptance/`.
`tests/renderer/markdown.test.ts` is a `react-dom/server` smoke test (no DOM, no extra deps):
it asserts markdown constructs, monotonic `data-src` offsets that map back to the source, and
inline-safe frame markup. There is still no IPC-handler or end-to-end harness.

CI (`.github/workflows/ci.yml`) runs the same checks plus a build on every push and PR. The
release workflow packages Linux/macOS/Windows artifacts when a GitHub release is published.

---

## 7. Renderer styling

All styling is plain CSS in `src/renderer/src/assets/`; no CSS-in-JS, no Tailwind. `base.css` is
the only place tokens are defined and `main.tsx` imports it first — `lookup.css` shares those
tokens and must not redefine them (it used to, which is how the popup drifted).

- **Tokens** (`:root` in `base.css`): surfaces (`--bg`, `--surface-1..3`), text tiers (`--text-1`,
  `--text-2`, `--text-3`; `--text-muted` aliases the third), accent (`--accent`, `--accent-soft`,
  `--accent-ring`, `--accent-contrast` for text on an accent fill), semantic (`--success`,
  `--error`/`--danger`, `--danger-soft`), shape (`--radius-sm|md|lg|pill`), elevation
  (`--shadow-1..3`), focus (`--focus-ring`, `--focus-ring-inset`), motion (`--dur-1`, `--dur-2`,
  `--ease-out`), layers (`--z-menu`, `--z-overlay`), type (`--font-sans`, `--font-display`,
  `--font-mono`) and `--content-width`. Use a token; never hardcode a hex colour or px radius in a
  surface stylesheet.
- **Controls**: `.btn` with `--primary` / `--danger` / `--sm` modifiers, and `.field` for text
  inputs and selects. A view must not invent its own button style.
- **Focus**: buttons and clickable elements get the shared `:focus-visible` outline from
  `base.css`. Form controls are excluded there and instead switch `border-color` plus
  `--focus-ring-inset` on `:focus`, so a field never shows two rings.
- **Text selection**: `body` allows selection; chrome (sidebar, toolbar, buttons, labels, hints)
  opts out with `user-select: none`.
- **Scrollbars**: one global `*::-webkit-scrollbar` rule guarantees no native OS scrollbar; a
  surface may refine width or colour on top of it.
- **Motion**: every animation and transition collapses under `prefers-reduced-motion: reduce`.
- **Fonts**: system stacks only. The renderer CSP (`style-src 'self'`) blocks remote stylesheets,
  so a webfont `@import` silently never applies — the display serif is `--font-display`.
- **Narrow windows**: the sidebar collapses to a 64px icon rail at ≤860px (labels hidden, `title`
  attributes carry the names); at ≤720px the chat drops its toolbar title, key hints and message
  measure so the composer keeps its width.

---

## 8. Invariants

These are load-bearing; breaking one causes a bug that is hard to trace:

- Provider dispatch exists **only** in `provider.ts`. Everything else asks for a `RoleId`.
- Prompt text exists **only** in `shared/prompts.ts`.
- Expansion state is `ExpansionNode[]` over the markdown `content` string, anchored by absolute
  source offsets. Selection ranges are re-resolved from `[data-src]` leaves at submit time and
  the covered source slice must equal the selected text exactly; no `Range` object survives into
  React state and no string search is used. A range must sit inside one mdast text node.
- Streaming patches only an expansion's `answer` (children and offsets are untouched);
  `status` stays `'loading'` until `done`, and a `done` with no output becomes an error. Every
  save/load runs `finalizeTurns`, so a persisted conversation never contains a `'loading'` frame.
- Autosaves are serialised per conversation id in main, `kbFed` is preserved on renderer saves,
  and every successful write also replaces the `{id}.meta.json` sidecar. Reads never trust a
  stale sidecar: list/search backfill it from the body.
- Read-modify-write goes through `mutateConversation`; never `loadConversation` + `saveConversation`
  for a partial update (that races an in-flight autosave).
- Rename/fold/dismiss never move `updatedAt` (content recency) — only content changes do.
- Both windows run the same bundle and the same `chat-*` channel family; responses go through
  `safeSend` and are scoped to `event.sender`, so the two windows cannot cross-talk and a closed
  popup cannot throw mid-stream. `activeStreams` records the owning `senderId`: only the window
  that started a request may cancel it, and a destroyed sender aborts its stream.
- `chat-cancel` aborts the provider stream via the `AbortSignal` passed into
  `callProviderStream`; a cancelled send still reports its accumulated partial text. The
  renderer removes the id from its request book first, so late chunks are no-ops.
- Context trimming is fail-open: `applyContextBudget` returns the messages unchanged whenever the
  catalog has no usable `contextWindow` (or anything throws). Trimming must never be the reason a
  request fails, and it applies to `chat` only — lookups keep their full screen context.
- `serializeForChat` never sends `error: true` or blank/whitespace assistant turns;
  `persistableTurns` drops blank assistant placeholders before any conversation save.
- OCR results are applied through `applyOcrResult` (token + liveness check), and OCR jobs are
  serialized behind one queue — the tesseract worker is shared.
- Persisted config, KB and conversation state is replaced via temp file + rename; never write
  those files directly.
- The main process never mutates renderer payloads in place.
- Renderer state updates stay pure: no IPC call or ref write inside a `setState` updater.
- Scrollbars are custom (`::-webkit-scrollbar`), never the native OS scrollbar.

---

## 9. Known gaps

- No tests for the IPC handlers, the chat hook itself, or the OCR pipeline. Renderer tests
  cover pure modules (`chat-requests`) and `react-dom/server` markdown; the acceptance gate is
  typecheck + lint + unit tests + format.
- `kb-reanalyze` has no progress reporting and an automatic pass reports only its start/finish
  through `kb-status`; a long run shows no per-conversation progress.
- No auto-update path; releases are manual downloads.
