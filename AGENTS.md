# AGENTS.md

Guidance for AI coding agents (and humans pairing with them) working on Delta AI.
Reflects the **actual current codebase**. `ARCHITECTURE.md` may lag behind; when they
disagree, the source in `src/` wins.

## Project at a glance

Delta AI is an Electron desktop app (BYOK) that:

- Provides a ChatGPT-like chat UI (React renderer).
- On a global hotkey, captures the screen around the cursor, runs OCR (tesseract.js),
  and shows an always-on-top lookup popup next to the cursor with the AI's response.
- Targets Linux (X11 and KDE Plasma Wayland are first-class), with macOS/Windows as
  secondary targets.

See `README.md` for the product vision and `ARCHITECTURE.md` for a data-flow diagram.

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
    │  window.api.{sendMessage, saveConfig, loadConfig, loadSettings, saveSettings}
    ▼
Preload (contextBridge)      src/preload/index.ts (+ index.d.ts)
    │  ipcRenderer.invoke(...)
    ▼
Main process (Node)          src/main/
    ├── index.ts            Provider dispatch + callGoogleAI, main window, app lifecycle
    ├── lookup.ts           OCR / screen-capture pipeline + lookup popup window
    ├── config.ts           Persistence + Wayland detection + global-hotkey registry
    ├── globalShortcutPortal.ts  XDG GlobalShortcuts D-Bus routing (Wayland)
    ├── screenCapturePortal.ts   Freedesktop Screenshot D-Bus routing (KDE Wayland)
    └── lookupHTML.ts       Inline HTML/JS for the lookup popup (data: URL)
    ▼
OS  (fs config/, Google Gemini API, tesseract WASM, D-Bus portals, desktopCapturer)
```

Build orchestration lives in `electron.vite.config.ts`, which builds three bundles:
main (cjs), preload (cjs), renderer (esm + HTML + CSS).

### Why the main process is split across files

The older `ARCHITECTURE.md` describes a single `src/main/index.ts` holding everything.
That is **stale** — the process is now split by concern:

- `index.ts` — app lifecycle, main chat window, `callProvider` (provider dispatch) and
  `callGoogleAI` (private). Callers should never branch on `config.provider` themselves;
  they call `callProvider(messages)` and handle `NoApiKeyError` /
  `UnsupportedProviderError`.
- `lookup.ts` — the OCR → AI pipeline for the hotkey-driven lookup, plus its own popup
  `BrowserWindow`. Owns no provider logic.
- `config.ts` — persists `config/providers.json` and `config/settings.json`, detects
  Wayland/KDE sessions, and registers the global hotkey (routing to the portal on
  Wayland, to `globalShortcut` elsewhere).
- `globalShortcutPortal.ts` / `screenCapturePortal.ts` — D-Bus talk to the Freedesktop
  portals. These exist specifically to dodge broken remember-choice dialogs on KDE
  Plasma Wayland.

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
- **Imports**: named, grouped loosely by source. Use `import type` for type-only
  imports (see `lookup.ts` importing `ProviderMessage` from `index.ts`).
- **Error handling**: main-process async functions return cleanly structured error
  information to the renderer (e.g. `{ success, error }` from IPC handlers; sentinel
  error classes `NoApiKeyError` / `UnsupportedProviderError` for the provider dispatch).
  Don't `console.log` errors that the user should see; surface them to a window.
- **Display types**: IPC payloads use `Array<{ role: string; content: string }>` and
  `{ success: boolean; response?: string; error?: string }` — mirror these in both the
  preload (`index.ts`/`index.d.ts`) and the renderer.

### React (renderer)

- File extension `.tsx`. Components are function components returning `React.JSX.Element`
  (see `App.tsx:13`). No prop types file — inline `type` aliases.
- Styling is plain CSS in `assets/main.css` / `assets/base.css`, using the `:root`
  CSS variables documented in `ARCHITECTURE.md`. Do not introduce CSS-in-JS or Tailwind
  without discussion.
- Keep the renderer thin: it talks only to `window.api`. privileged work belongs in the
  main process.

## Key modules (what to touch when)

| Task                                       | File                            |
| ------------------------------------------ | ------------------------------- |
| Add an AI provider                         | `index.ts` (`callProvider` switch) |
| Change the OCR/capture pipeline            | `lookup.ts`                    |
| Re-position / restyle the lookup popup     | `lookup.ts` + `lookupHTML.ts`   |
| Persist or load user config/settings       | `config.ts`                    |
| Wayland global-shortcut binding           | `globalShortcutPortal.ts`       |
| KDE Wayland silent screenshot              | `screenCapturePortal.ts`        |
| Renderer chat UI                          | `src/renderer/src/App.tsx`      |
| Settings form                              | `src/renderer/src/components/Settings.tsx` |
| Add a new IPC channel                      | preload `index.ts` + `.d.ts`, then main `index.ts`/`config.ts` |

## Conventions worth remembering

- **Provider dispatch lives in `index.ts`.** `callProvider(messages)` reads the config
  and selects the backend; everyone else (the `send-message` IPC handler, `lookup.ts`)
  calls it and handles the sentinel errors. Don't duplicate the
  `loadProviderConfig()` + `config.provider === ...` branching elsewhere.
- **The lookup popup is a normal 420×320 always-on-top `BrowserWindow`**
  created inside `lookup.ts` (not exported). Position is best-effort near the
  cursor via `new BrowserWindow({x, y})`; the compositor may center it on
  Wayland, which is acceptable. Use `sendToWindow` rather than touching the
  window ref directly. The window loads the shared preload and talks only via
  `window.api.lookupOn*`.
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
- **`path` vs `path/posix`**: `config.ts` uses `path`, `lookup.ts` uses `path/posix`. The
  tesseract cache path build uses `path/posix` deliberately — match the existing import
  in the file you're editing.
- **Function ordering in `lookup.ts`**: `handleHotkeyPressed` (the entry-point) comes
  first. Functions it calls follow in the order they are first called, recursively.
  Module state (constants, `let` vars) comes at the top. Use section comments
  (`/* ---- Section ---- */`) sparingly to group related blocks. This ordering makes
  the hotkey pipeline readable top-to-bottom without forward references.

## Do not

- Don't add dependency `globalShortcut`-based commands without going through
  `registerHotkey` (the portal path won't fire otherwise on Wayland).
- Don't import Electron main APIs into the renderer; use the preload bridge.
- Don't commit secrets. Provider API keys live only in `{userData}/config/providers.json`
  on the user's machine — never in source.
- Don't update `ARCHITECTURE.md` description sections without also checking the source;
  it is intentionally kept high-level but should not contradict `src/`.

## Updating this file

When the architecture changes meaningfully (new module split, new IPC channels, new
provider, new window), update both this file **and** `ARCHITECTURE.md`. This file is the
source that agents read first; keep it accurate.
