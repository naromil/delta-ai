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

| Module                                              | Responsibility                                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/models.ts`                              | Provider/role registries, `Connection`, `RoleAssignment`, `ModelConfig`, `ProviderMessage`, keyword types                                                                                                                                                         |
| `src/shared/conversation.ts`                        | `ConversationState` / `Turn` / `ExpandableSegment` and every pure helper over them: `tokenize`, `flattenMarkdown`, `insertExpansion(Nested)`, `findTextSelectionRange`, `findExpansionInSegments`, `maxExpansionId`, `buildConversationTitle`, `serializeForChat` |
| `src/shared/prompts.ts`                             | Every LLM-facing string: system prompts, screen-context template, lookup default, expand instructions, KB prompts                                                                                                                                                 |
| `src/shared/expand-prompt.ts`                       | `buildExpandMessages({ answer, selection, prompt? })`                                                                                                                                                                                                             |
| `src/main/index.ts`                                 | App lifecycle, main window, tray, streaming IPC (`chat-send`, `chat-expand`), lookup grow, lookup → chat transfer, conversation CRUD channels                                                                                                                     |
| `src/main/provider.ts`                              | The single dispatch point: role → connection → backend. `callProviderStream` is the only primitive; `callProvider` drains it                                                                                                                                      |
| `src/main/config.ts`                                | `providers.json` / `settings.json` I/O, hotkey registration (X11 + portal), Wayland detection                                                                                                                                                                     |
| `src/main/models/config-schema.ts`                  | Zod validation, schema migrations (v1→v2), repair of dangling roles and unknown provider types                                                                                                                                                                    |
| `src/main/services/model-catalog.ts`                | models.dev catalog fetch, 24h disk cache, offline fallback, `load-model-catalog` IPC                                                                                                                                                                              |
| `src/shared/model-catalog.ts`                       | `CatalogModel`/`ModelCatalog` types, provider-id mapping, flattening and formatting helpers                                                                                                                                                                       |
| `src/main/conversations.ts`                         | Conversation record CRUD under `{userData}/conversations/`                                                                                                                                                                                                        |
| `src/main/lookup/lookup.ts`                         | Hotkey entry point: clipboard → OCR fallback → popup session                                                                                                                                                                                                      |
| `src/main/lookup/capture.ts`                        | Screen capture (portal-first on KDE Wayland) and the single serialized tesseract.js worker                                                                                                                                                                        |
| `src/main/lookup/window.ts`                         | Popup `BrowserWindow`, `?role=lookup` load, grow animation, per-window channels, one-time OCR IPC handler                                                                                                                                                         |
| `src/main/lookup/state.ts`                          | `LookupSession`, `notifySessionState`, `applyOcrResult`, liveness helpers                                                                                                                                                                                         |
| `src/main/lookup/handlers.ts`                       | Paste-text / paste-image handlers                                                                                                                                                                                                                                 |
| `src/main/kb/analysis.ts`                           | Structured conversation material + analysis/keyword message construction                                                                                                                                                                                          |
| `src/main/kb/keywords.ts`                           | Pure keyword parsing, merging, per-category trimming                                                                                                                                                                                                              |
| `src/main/kb/store.ts`                              | `{userData}/kb/prompt.txt` and `keywords.json` I/O                                                                                                                                                                                                                |
| `src/main/kb/handlers.ts`                           | `kb-load-prompt`, `kb-analyze`, `kb-reanalyze`                                                                                                                                                                                                                    |
| `src/main/services/global-shortcut.ts`              | `org.freedesktop.portal.GlobalShortcuts` over D-Bus                                                                                                                                                                                                               |
| `src/main/services/screen-capture.ts`               | `org.freedesktop.portal.Screenshot` over D-Bus (silent capture)                                                                                                                                                                                                   |
| `src/renderer/src/hooks/useChatStreaming.ts`        | Owns `ConversationState`, correlates `requestId`s, auto-saves                                                                                                                                                                                                     |
| `src/renderer/src/hooks/useExpansionContextMenu.ts` | The right-click → selection/word → Expand pipeline, shared by both windows                                                                                                                                                                                        |

---

## 2. Call chains

### Chat send

1. `Conversation` composer → `useChatStreaming.send(text)`.
2. `serializeForChat(state, role)` builds the provider messages: the system prompt always, the
   screen-context preamble when a context exists or `role === 'lookup'`, then every turn.
3. `window.api.chatSend({ messages, requestId, role })` → `chat-send` in `index.ts`.
4. For `role: 'lookup'` the main process appends the KB personalization prompt to the system
   message (`withKbPrompt`) before dispatch.
5. `callProviderStream(messages, roleId)` resolves the role assignment and streams deltas.
6. Each delta is sent back as `chat-chunk` with the **cumulative** text; `chat-response` closes
   the turn. The renderer tokenizes the final text into segments and saves the conversation.

### Inline expand

1. `useExpansionContextMenu` turns a right-click into `(turnId, selection, startIndex, endIndex,
offsets, parentAnswer, prompt?)` — indices are computed against the segment tree, never
   against a live DOM `Range`.
2. `useChatStreaming.expand` inserts a loading expansion into the segment tree, then sends
   `chat-expand` with `buildExpandMessages`.
3. `chat-expand-chunk` carries `{ text, done? }` or `{ error }`; the tree is updated via
   `updateExpansionInTurns`, and the conversation is saved on completion.
4. Cross-frame selections are refused (`insertExpansion` returns `startIndex: -1`), which the UI
   surfaces as a disabled menu item.

### Look-up hotkey

1. `registerHotkey` fires `handleHotkeyPressed` (portal signal on Wayland, `globalShortcut` on X11).
2. In `clipboard` mode: `wl-paste` text → clipboard image → OCR; anything found becomes the
   context. An empty clipboard falls back to the fullscreen capture path.
3. In `fullscreen-ocr` mode: capture the display under the cursor, run OCR, publish the text.
4. Every result goes through `applyOcrResult`, which drops stale jobs by `ocrToken` and a dead
   window by `isSessionAlive`.

### Look-up → chat transfer

`lookup-transfer` marshals the whole `ConversationState`. The main process turns the context
into a user turn (`buildScreenContextMessage`), writes the record once as `source: 'chat'`
preserving the original `createdAt`, and pushes `chat-replace-conversation` to the main window.

### Persistence and Knowledge Base

- Auto-save runs on response completion, expand completion, fold and unfold; empty conversations
  are never written.
- `kb-analyze` walks unfed conversations one at a time through the `kb-maintenance` role,
  persisting the rewritten prompt and marking each conversation fed **per conversation**, so an
  interrupted run keeps its progress.
- `kb-reanalyze(n)` reprocesses the `n` most recent conversations without marking them fed.
- The resulting prompt is injected into every lookup request; keywords are stored for future use.

---

## 3. IPC surface

| Channel                                                     | Direction    | Purpose                                          |
| ----------------------------------------------------------- | ------------ | ------------------------------------------------ |
| `chat-send` → `chat-chunk` / `chat-response` / `chat-error` | R → M, M → R | Streaming chat, correlated by `requestId`        |
| `chat-expand` → `chat-expand-chunk`                         | R → M, M → R | Streaming expansions (`done` / `error` markers)  |
| `chat-replace-conversation`                                 | M → R        | Hydrate a transferred conversation               |
| `lookup-trigger-grow` / `lookup-grow`                       | L → M, M → L | First-ask window growth                          |
| `lookup-context` / `ai-error`                               | M → L        | Context status and capture/OCR errors            |
| `lookup-paste-text` / `lookup-paste-image`                  | L → M        | Paste replaces the context                       |
| `lookup-ocr-image`                                          | L ↔ M        | OCR a pasted image, returns `{ text, error? }`   |
| `lookup-input-changed` / `lookup-close` / `lookup-ready`    | L → M        | Blur guard, close, listener-ready handshake      |
| `lookup-transfer`                                           | L → M        | Send the popup conversation to the chat window   |
| `conversation-save` / `-load` / `-delete` / `-list`         | R ↔ M        | Conversation CRUD                                |
| `conversation-load-most-recent` / `-list-unfed` / `-kb-fed` | R ↔ M        | Startup restore and KB integration               |
| `load-settings` / `save-settings`                           | R ↔ M        | Hotkey, close-to-tray, lookup context mode       |
| `load-model-config` / `save-model-config`                   | R ↔ M        | Connections and role assignments                 |
| `load-model-catalog`                                        | R ↔ M        | models.dev model catalog (cached, force-refresh) |
| `kb-load-prompt` / `kb-analyze` / `kb-reanalyze`            | R ↔ M        | Knowledge Base                                   |

---

## 4. On-disk format

```
{userData}/
  config/providers.json     ModelConfig (schemaVersion 2)
  config/settings.json      { hotkey, closeToTray, lookupContextMode }
  cache/models-dev.json     models.dev snapshot (24h TTL, offline fallback)
  conversations/{id}.json   ConversationRecord
  kb/prompt.txt             personalization prompt (plain text)
  kb/keywords.json          CategorizedKeyword[]
  tesseract-cache/          tesseract.js traineddata
```

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
- The compositor may centre the popup instead of honouring the requested position.
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

Tests live in `tests/` and only cover pure modules (`shared/conversation`, `main/kb/keywords`,
`main/provider` with a mocked config). There is no renderer or end-to-end harness yet.

CI (`.github/workflows/ci.yml`) runs the same checks plus a build on every push and PR. The
release workflow packages Linux/macOS/Windows artifacts when a GitHub release is published.

---

## 7. Invariants

These are load-bearing; breaking one causes a bug that is hard to trace:

- Provider dispatch exists **only** in `provider.ts`. Everything else asks for a `RoleId`.
- Prompt text exists **only** in `shared/prompts.ts`.
- Expansion state lives in the `ExpandableSegment` tree, not in the DOM. Indices are snapshotted
  at right-click time; no `Range` objects survive into React state.
- Both windows run the same bundle and the same `chat-*` channel family; responses are scoped to
  `event.sender`, so the two windows cannot cross-talk.
- OCR results are applied through `applyOcrResult` (token + liveness check), and OCR jobs are
  serialized behind one queue — the tesseract worker is shared.
- The main process never mutates renderer payloads in place.
- Renderer state updates stay pure: no IPC call or ref write inside a `setState` updater.
- Scrollbars are custom (`::-webkit-scrollbar`), never the native OS scrollbar.

---

## 8. Known gaps

- No tests for the renderer, the IPC handlers, or the OCR pipeline; the acceptance gate is
  typecheck + lint + unit tests + format.
- The KB personalization prompt is only injected into lookup requests, not chat requests.
- `kb-reanalyze` has no progress reporting: a long run shows nothing until it returns.
- No auto-update path; releases are manual downloads.
