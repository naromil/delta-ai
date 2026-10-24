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
                        models.ts · conversation.ts · prompts.ts · expand-prompt.ts
```

| Module                                                            | Responsibility                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/models.ts`                                            | Provider/role registries, `Connection`, `RoleAssignment`, `ModelConfig`, `ProviderMessage`, keyword types                                                                                                                                                                             |
| `src/shared/conversation.ts`                                      | `ConversationState` / `Turn` / `ExpandableSegment` and every pure helper over them: `tokenize`, `flattenMarkdown`, `insertExpansion(Nested)`, `findTextSelectionRange`, `findExpansionInSegments`, `maxExpansionId`, `buildConversationTitle`, `persistableTurns`, `serializeForChat` |
| `src/shared/prompts.ts`                                           | Every LLM-facing string: system prompts, screen-context template, lookup default, expand instructions, KB prompts                                                                                                                                                                     |
| `src/shared/expand-prompt.ts`                                     | `buildExpandMessages({ answer, selection, prompt? })`                                                                                                                                                                                                                                 |
| `src/main/index.ts`                                               | App lifecycle, main window, tray, streaming IPC (`chat-send`, `chat-expand`, `chat-cancel`), lookup grow/transfer, conversation CRUD + search channels                                                                                                                                |
| `src/main/provider.ts`                                            | The single dispatch point: role → connection → backend. `callProviderStream(…, signal?)` is the only primitive; `callProvider` drains it; an abort ends the stream                                                                                                                    |
| `src/main/services/atomic-file.ts`                                | `writeFileAtomic[Sync]`: sibling temp file + rename, so interrupted writes never leave truncated JSON/text                                                                                                                                                                            |
| `src/main/config.ts`                                              | `providers.json` / `settings.json` I/O, hotkey registration (X11 + portal), register-before-save, startup fallback, Wayland detection                                                                                                                                                 |
| `src/main/models/config-schema.ts`                                | Zod validation, schema migrations (v1→v2), repair of dangling roles/unknown providers; empty `connectionId` → `null` (unassigned)                                                                                                                                                     |
| `src/main/services/model-catalog.ts`                              | models.dev catalog fetch, 24h disk cache, offline fallback, `load-model-catalog` IPC                                                                                                                                                                                                  |
| `src/shared/model-catalog.ts`                                     | `CatalogModel`/`ModelCatalog` types, provider-id mapping, flattening and formatting helpers                                                                                                                                                                                           |
| `src/main/conversations.ts`                                       | Conversation record CRUD (atomic) under `{userData}/conversations/`; title + content search, KB-fed marking and `resetKbFedFlags`                                                                                                                                                     |
| `src/main/lookup/lookup.ts`                                       | Hotkey entry point: clipboard → OCR fallback → popup session                                                                                                                                                                                                                          |
| `src/main/lookup/capture.ts`                                      | Screen capture (portal-first on KDE Wayland) and the single serialized tesseract.js worker                                                                                                                                                                                            |
| `src/main/lookup/window.ts`                                       | Popup `BrowserWindow`, `?role=lookup` load, grow animation, per-window channels, one-time OCR IPC handler                                                                                                                                                                             |
| `src/main/lookup/state.ts`                                        | `LookupSession`, `notifySessionState`, `applyOcrResult`, liveness helpers                                                                                                                                                                                                             |
| `src/main/lookup/handlers.ts`                                     | Paste-text / paste-image handlers                                                                                                                                                                                                                                                     |
| `src/main/kb/analysis.ts`                                         | Structured conversation material + analysis/keyword message construction                                                                                                                                                                                                              |
| `src/main/kb/keywords.ts`                                         | Pure keyword parsing, merging, per-category trimming                                                                                                                                                                                                                                  |
| `src/main/kb/run.ts`                                              | `runKbAnalysis(metas, { markFed, signal })`: folds conversations into the prompt and keywords, persisting per conversation, skipping empty/look-up records                                                                                                                            |
| `src/main/kb/schedule.ts`                                         | Pure pacing policy: debounce, batch size, backlog interval, exponential retry, startup delay                                                                                                                                                                                          |
| `src/main/kb/maintenance.ts`                                      | Automatic maintenance loop: save/config subscriptions, single-flight queue, bounded passes, backoff, `kb-status` fan-out, reset that aborts a running pass                                                                                                                            |
| `src/main/kb/store.ts`                                            | `{userData}/kb/prompt.txt`, `keywords.json`, `state.json` I/O (atomic); `resetKb` deletes all three                                                                                                                                                                                   |
| `src/main/kb/handlers.ts`                                         | `kb-load-prompt`, `kb-save-prompt`, `kb-reset`, `kb-get-status`, manual `kb-analyze`/`kb-reanalyze` (queued with the automatic loop)                                                                                                                                                  |
| `src/main/services/global-shortcut.ts`                            | `org.freedesktop.portal.GlobalShortcuts` over D-Bus                                                                                                                                                                                                                                   |
| `src/main/services/screen-capture.ts`                             | `org.freedesktop.portal.Screenshot` over D-Bus (silent capture)                                                                                                                                                                                                                       |
| `src/renderer/src/hooks/useChatStreaming.ts`                      | Owns `ConversationState`, correlates `requestId`s, stop/retry, auto-saves                                                                                                                                                                                                             |
| `src/renderer/src/components/conversation/ConversationSearch.tsx` | Ctrl/Cmd+K search modal: `conversation-search`, snippets, load/delete + delete-error banner                                                                                                                                                                                           |
| `src/renderer/src/hooks/useExpansionContextMenu.ts`               | The right-click → selection/word → Expand pipeline, shared by both windows                                                                                                                                                                                                            |

---

## 2. Call chains

### Chat send

1. `Conversation` composer → `useChatStreaming.send(text)`.
2. `serializeForChat(state, role)` builds the provider messages: the system prompt always, the
   screen-context preamble when a context exists or `role === 'lookup'`, then every turn —
   assistant turns flagged `error: true` or containing only blank/whitespace are omitted, so
   neither error text nor in-flight placeholders are replayed.
3. `window.api.chatSend({ messages, requestId, role })` → `chat-send` in `index.ts`.
4. For `role: 'lookup'` the main process appends the KB personalization prompt to the system
   message (`withKbPrompt`) before dispatch.
5. `callProviderStream(messages, roleId, controller.signal)` resolves the role assignment and
   streams deltas. Main keeps the `AbortController` in `activeStreams`, keyed by `requestId`.
6. Each delta is sent back as `chat-chunk` with the **cumulative** text; `chat-response` closes
   the turn. The renderer tokenizes the final text into segments and saves the conversation.
7. The chat composer's Stop button sends `chat-cancel(requestId)`. Main aborts the provider
   request and closes with `chat-response { text: partial, cancelled: true }`; the renderer
   drops an empty assistant turn if no token arrived, otherwise keeps/saves the partial text.
   Retry (shown on an error turn) drops that failed answer and everything after it, then
   re-sends the remaining conversation.

### Inline expand

1. `useExpansionContextMenu` turns a right-click into `(turnId, selection, startIndex, endIndex,
offsets, parentAnswer, prompt?)` — indices are computed against the segment tree, never
   against a live DOM `Range`.
2. `useChatStreaming.expand` inserts a loading expansion into the segment tree, then sends
   `chat-expand` with `buildExpandMessages`.
3. `chat-expand-chunk` carries `{ text, done? }` or `{ error }`; a cancelled expand ends with
   `{ text: partial, done: true, cancelled: true }`. The tree is updated via
   `updateExpansionInTurns`, and the conversation is saved on completion.
4. Cross-frame selections are refused (`insertExpansion` returns `startIndex: -1`), which the UI
   surfaces as a disabled menu item.

### Look-up hotkey

1. `registerHotkey` fires `handleHotkeyPressed` (portal signal on Wayland, `globalShortcut` on X11).
2. In `clipboard` mode: `wl-paste` text → clipboard image → OCR; anything found becomes the
   context. An empty clipboard falls back to the fullscreen capture path.
3. In `fullscreen-ocr` mode: capture the display under the cursor, run OCR, publish the text.
4. Every result goes through `applyOcrResult`, which drops stale jobs by `ocrToken` and a dead
   window by `isSessionAlive`. `notifySessionState` also stores `pendingState`, so a popup whose
   renderer was not listening yet can replay the latest context via the `lookup-ready`
   handshake.

### Look-up → chat transfer

`lookup-transfer` marshals the whole `ConversationState`. The main process turns the context
into a user turn (`buildScreenContextMessage`), writes the record once as `source: 'chat'`
preserving the original `createdAt`, and pushes `chat-replace-conversation` with
`{ state, conversationId, conversationTitle, conversationCreatedAt }` to the main window; the
hook seeds its conversation metadata from that `createdAt` so later saves update the same record.

### Persistence and Knowledge Base

- Every config, KB and conversation write goes through `services/atomic-file.ts`, which writes
  a sibling temp file and renames it over the target.
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
| `conversation-load-most-recent` / `-list-unfed` / `-kb-fed` | R ↔ M        | Startup restore and KB integration                              |
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
      "apiKey": "AIza…",
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
or the config layer where needed: 13 files / 175 tests. Coverage includes `shared/conversation`
(multi-segment insertion, `insertExpansionNested.inserted`, `serializeForChat` omit rules),
`shared/model-catalog`, `main/kb/keywords`, `main/provider` (streaming, idle timeout after
partial output, external abort), `main/models/config-schema` (empty `connectionId` →
unassigned), `main/config-settings` (settings normalization), `main/conversations` (safe ids,
search ranking/snippets, `resetKbFedFlags`), `main/services/local-shortcut` (shifted keys), the
portal and model-catalog services, plus the supervisor-owned gates in `tests/acceptance/`.
There is no renderer, IPC-handler, or end-to-end harness yet.

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
- Expansion state lives in the `ExpandableSegment` tree, not in the DOM. Indices are snapshotted
  at right-click time; no `Range` objects survive into React state.
- Both windows run the same bundle and the same `chat-*` channel family; responses are scoped to
  `event.sender`, so the two windows cannot cross-talk.
- `chat-cancel` aborts the provider stream via the `AbortSignal` passed into
  `callProviderStream`; a cancelled send still reports its accumulated partial text.
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

- No tests for the renderer, the IPC handlers, or the OCR pipeline; the acceptance gate is
  typecheck + lint + unit tests + format.
- The KB personalization prompt is only injected into lookup requests, not chat requests.
- `kb-reanalyze` has no progress reporting and an automatic pass reports only its start/finish
  through `kb-status`; a long run shows no per-conversation progress.
- No auto-update path; releases are manual downloads.
