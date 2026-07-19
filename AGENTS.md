# AGENTS.md

Guidance for AI coding agents (and humans pairing with them) working on Delta AI.
Reflects the **actual current codebase**. `docs/architecture.md` may lag behind; when they
disagree, the source in `src/` wins.

## Project at a glance

Delta AI is an Electron desktop app (BYOK) that:

- Provides a ChatGPT-like chat UI (React renderer).
- On a global hotkey, captures the screen around the cursor, runs OCR (tesseract.js),
  and shows an always-on-top lookup popup next to the cursor with the AI's response.
- Targets Linux (X11 and KDE Plasma Wayland are first-class), with macOS/Windows as
  secondary targets.

See `README.md` for the product vision and `docs/architecture.md` for a data-flow diagram.

## Build, typecheck, lint

These are the commands you should know and run after non-trivial changes:

- `npm run dev` — launch the Electron app with HMR via electron-vite.
- `npm run typecheck` — runs `typecheck:node` then `typecheck:web` (both `tsc --noEmit`).
  - `typecheck:node` covers `src/main/**` and `src/preload/**` (`tsconfig.node.json`).
  - `typecheck:web` covers `src/renderer/src/**` and `src/preload/*.d.ts`
    (`tsconfig.web.json`).
- `npm run lint` — ESLint with `@electron-toolkit/eslint-config-ts` + Prettier rules.
- `npm run build` — typechecks then `electron-vite build`.
- `npm run format` — Prettier write across the repo.

Always run `npm run typecheck` and `npm run lint` after changing `.ts`/`.tsx`. The build
will fail on typecheck errors, so fix them before committing.

## Architecture (layers)

```
Renderer (React 19)          src/renderer/src/
    │  window.api.{sendMessage, saveConfig, loadConfig, saveAllProviders, loadAllProviders,
    │              loadSettings, saveSettings, lookupAsk, lookupPasteText, lookupPasteImage,
    │              lookupClose, lookupInputChanged, lookupOnContext, lookupOnResponse,
    │              lookupOnError, lookupOnGrow}
    ▼
Preload (contextBridge)      src/preload/index.ts (+ index.d.ts)
    │  ipcRenderer.invoke / ipcRenderer.send / ipcRenderer.on
    ▼
Main process (Node)          src/main/
    ├── index.ts            App lifecycle, main window + tray, send-message IPC handler
    ├── config.ts           Persistence + Wayland detection + hotkey registry + IPC handlers
    ├── provider.ts         Provider dispatch (callProvider + callOpenAICompatible + callGeminiWithSearch)
    ├── lookup/
    │   ├── lookup.ts       Orchestrator: handleHotkeyPressed entry point (no IPC wiring)
    │   ├── window.ts       Lookup popup BrowserWindow creation (420×320 → 840×640 grow), IPC wiring
    │   ├── capture.ts      Screen capture pipeline (desktopCapturer or KDE portal) + tesseract.js OCR
    │   ├── handlers.ts     Paste handlers + lookup Ask handler (builds messages, calls provider)
    │   ├── html.ts         Inline HTML/CSS/JS for the lookup popup (loaded as data: URL)
    │   └── state.ts        LookupSession interface + lookupSessions array + helpers
    └── services/
        ├── global-shortcut.ts  XDG GlobalShortcuts D-Bus portal routing (Wayland)
        └── screen-capture.ts   Freedesktop Screenshot D-Bus portal routing (KDE Wayland)
    ▼
OS  (fs config/, Google Gemini API, tesseract WASM, D-Bus portals, desktopCapturer)
```

Build orchestration lives in `electron.vite.config.ts`, which builds three bundles:
main (cjs), preload (cjs), renderer (esm + HTML + CSS).

### Renderer directory layout

```
src/renderer/src/
├── main.tsx              React entry point (StrictMode)
├── App.tsx               Root component: chat/settings view routing, message state
├── assets/
│   ├── main.css          Aggregator: @imports base.css, chat.css, settings.css
│   ├── base.css          CSS custom properties (dark theme :root vars)
│   ├── chat.css          Chat UI styles
│   └── settings.css      Settings page styles
├── views/
│   ├── chat/
│   │   └── ChatView.tsx      Chat UI: message list, textarea input, auto-scroll
│   └── settings/
│       └── Settings.tsx      Settings page: provider selection, hotkey, general settings
└── components/
    └── settings/
        ├── GoogleAiForm.tsx  Google AI Studio provider form (API key, model, web search toggle)
        ├── OpenAiForm.tsx    OpenAI-compatible provider form (API key, baseUrl, model)
        └── HotkeyInput.tsx   Hotkey capture input widget
```

### Why the main process is split across files

The older `docs/architecture.md` describes a single `src/main/index.ts` holding everything.
That is **stale** — the process is now split by concern:

- `index.ts` — app lifecycle, main chat window + tray, `send-message` IPC handler.
  Provider dispatch lives in `provider.ts` now; `index.ts` imports `callProvider` from
  there and imports `handleHotkeyPressed` from `lookup/lookup`.
- `config.ts` — persists `config/providers.json` and `config/settings.json`, detects
  Wayland/KDE sessions, registers the global hotkey (routing to the portal on
  Wayland, to Electron's `globalShortcut` elsewhere). Owns IPC handlers:
  `save-settings`, `load-settings`, `save-config`, `load-config`, `save-all-providers`,
  `load-all-providers`.
- `lookup/` module — the OCR → AI pipeline for the hotkey-driven lookup, plus its own
  popup `BrowserWindow`. Entry point is `lookup/lookup.ts` (`handleHotkeyPressed`);
  window creation and IPC wiring is in `window.ts`. Owns no provider logic.
- `services/` — `global-shortcut.ts` and `screen-capture.ts`: D-Bus talk to the
  Freedesktop portals. These exist specifically to dodge broken remember-choice
  dialogs on KDE Plasma Wayland.

When adding main-process logic, put it where its concern lives — do not re-grow
`index.ts` into a monolith.

## Coding style

Enforced by ESLint + Prettier config; match what already exists:

- **Prettier** (`.prettierrc.yaml`): single quotes, no semicolons, `printWidth: 100`,
  `trailingComma: none`.
- **TypeScript strict** (via `@electron-toolkit/tsconfig`): prefer explicit types on
  exported function signatures and on union/string-literal return types; let locals be
  inferred where obvious.
- **No eslint-disable unless truly warranted.** The repo already disables
  `@typescript-eslint/no-explicit-any` on one line (the tesseract.js worker) — that's a
  pattern to copy if a third-party API is untyped, rather than scattering `any` around.
- **Comments**: sparse, purposeful. Use `/* ---- Section ---- */` dividers in main-process
  files (see `index.ts`, `config.ts`). Do not add comments that restate the code.
- **Function ordering (C-style)**: in any file containing multiple functions or blocks,
  order them so that **callees appear before callers**.
  When a caller invokes multiple callees in sequence,
  order those parallel callees in a **logical and sequential** order.
- **Imports**: named, grouped loosely by source. Use `import type` for type-only
  imports (see `lookup/handlers.ts:1` importing `LookupSession` from `./state`,
  and `index.ts:14` importing `ProviderMessage` from `./provider`).
- **Error handling**: main-process async functions return cleanly structured error
  information to the renderer (e.g. `{ success, error }` from IPC handlers; sentinel
  error classes `NoApiKeyError` / `UnsupportedProviderError` for the provider dispatch).
  Don't `console.log` errors that the user should see; surface them to a window.
- **Display types**: IPC payloads use `Array<{ role: string; content: string }>` and
  `{ success: boolean; response?: string; error?: string }` — mirror these in both the
  preload (`index.ts`/`index.d.ts`) and the renderer.

### React (renderer)

- File extension `.tsx`. Components are function components returning `React.JSX.Element`
  (see `App.tsx`). No prop types file — inline `type` aliases.
- Styling is plain CSS in `assets/`, using the `:root` CSS variables documented in
  `docs/architecture.md`. Do not introduce CSS-in-JS or Tailwind without discussion.
- Keep the renderer thin: it talks only to `window.api`. privileged work belongs in the
  main process.

## Key modules (what to touch when)

| Task                                   | File(s)                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------- |
| Add an AI provider                     | `provider.ts` (`callProvider` switch)                                   |
| Change the OCR/capture pipeline        | `lookup/capture.ts`                                                     |
| Change the hotkey response flow        | `lookup/lookup.ts` (`handleHotkeyPressed`)                              |
| Re-position / restyle the lookup popup | `lookup/window.ts` + `lookup/html.ts`                                   |
| Persist or load user config/settings   | `config.ts`                                                             |
| Wayland global-shortcut binding        | `services/global-shortcut.ts`                                           |
| KDE Wayland silent screenshot          | `services/screen-capture.ts`                                            |
| Renderer chat UI                       | `src/renderer/src/views/chat/ChatView.tsx`                              |
| Settings form                          | `src/renderer/src/views/settings/Settings.tsx`                          |
| Provider config form                   | `src/renderer/src/components/settings/GoogleAiForm.tsx` / `OpenAiForm.tsx` |
| Add a new IPC channel                  | preload `index.ts` + `.d.ts`, then main `index.ts`/`config.ts`          |

## Conventions worth remembering

- **Provider dispatch lives in `provider.ts`.** `callProvider(messages, webSearchEnabled?)`
  reads the config and selects the backend; everyone else (the `send-message` IPC handler,
  `lookup/handlers.ts`) calls it and handles the sentinel errors. Don't duplicate the
  `loadCurrentProviderConfig()` + `config.provider === ...` branching elsewhere.
- **The lookup popup is a normally 420×320 always-on-top frameless `BrowserWindow`**
  created inside `lookup/window.ts` via `createLookupSession`. It loads its own inline
  HTML via a `data:text/html` URL (see `lookup/html.ts`). Position is best-effort near the
  cursor via `new BrowserWindow({x, y})`; the compositor may center it on Wayland, which
  is acceptable. When the user submits a question the window grows to 840×640 via
  `animateGrowSession` + a `lookup-grow` IPC signal.
- **There can be multiple lookup sessions.** The global `lookupSessions` array in
  `state.ts` owns `LookupSession` objects, each holding its window ref, OCR context
  text, OCR token (for stale-request cancellation), `grown` flag, `contextReady` flag,
  and `hasText` flag. Use `isSessionAlive` / `sendToSession` / `notifySessionState`
  rather than touching window refs directly.
- **Lookup blur behaviour:** a window closes on blur only when the user has never
  focused it (`hasBeenFocused` guard in `window.ts:54-56`), is not grown, and the
  Ask field is empty (`!session.hasText`). Once a message has been sent (grown),
  the window stays open on blur so the user can keep consulting it while triggering
  new lookups.
- **OCR captures the full screen, not a cropped region around the cursor.**
  `captureScreen()` grabs the entire display; `runOCR()` processes the whole
  image. Cursor position may fail on Wayland (`getCursorScreenPoint()` returns
  `(0,0)`), but the full-screen capture + full-image OCR makes the feature
  still work regardless.
- **Portal code is KDE/Wayland-specific by design.** `isScreenCapturePortalPreferred()`
  and `isKdeWaylandSession()` gate it. Keep `desktopCapturer` as the default for
  X11/macOS/Windows and non-KDE Wayland.
- **Config files** live under `{userData}/config/` (`providers.json`, `settings.json`).
  Always go through `config.ts` helpers; remember to call `ensureConfigDir()` before
  writing.
- **Hotkey registry** is in `config.ts:registerHotkey`. It auto-routes through the XDG
  GlobalShortcuts portal on Wayland. When `save-settings` changes the hotkey, it
  re-registers by calling `registerHotkey` with `handleHotkeyPressed` — keep that
  callback wiring intact.
- **`path` vs `path/posix`**: `config.ts` and `index.ts` use `path`,
  `lookup/capture.ts` and `lookup/window.ts` use `path/posix`. The
  tesseract cache path build uses `path/posix` deliberately — match the existing import
  in the file you're editing.
- **Tray support**: `index.ts:71-102` creates a `Tray` with a context menu
  (Show/Quit). `config.ts:currentCloseToTray` controls whether closing the main window
  hides to tray instead of quitting. The `close` handler in `createWindow` checks
  `currentCloseToTray && !isQuitting` to decide.

## Do not

- Don't add dependency `globalShortcut`-based commands without going through
  `registerHotkey` (the portal path won't fire otherwise on Wayland).
- Don't import Electron main APIs into the renderer; use the preload bridge.
- Don't commit secrets. Provider API keys live only in `{userData}/config/providers.json`
  on the user's machine — never in source.
- Don't update `docs/architecture.md` description sections without also checking the source;
  it is intentionally kept high-level but should not contradict `src/`.

## Updating this file

When the architecture changes meaningfully (new module split, new IPC channels, new
provider, new window), update both this file **and** `docs/architecture.md`. This file is the
source that agents read first; keep it accurate.
