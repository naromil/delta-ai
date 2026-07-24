# Delta AI

**An always-on desktop AI assistant for learning anything.**  
Screen-aware, multi-provider, privacy-respecting — built with Electron + React 19.

Delta AI lives in two windows: a full **chat** interface and an **always-on-top lookup popup** that captures your screen, runs OCR, and answers questions about what you're reading. A global hotkey opens the popup instantly over any application.

---

## Features

- **Screen-aware lookup** — Press `Ctrl+Shift+D` (configurable) to capture the screen, OCR it with tesseract.js, and open a popup that can answer questions about what you see.
- **Inline expansions** — Right-click any word or selection in an assistant response to get an instant definition or custom explanation. Expansions render inline as foldable frames; nested expansions are supported.
- **Multi-provider AI** — Bring your own key (BYOK) for Google AI Studio, OpenAI, OpenAI-compatible endpoints, Ollama, or OpenRouter. Each conversation role (chat, lookup) maps independently to a provider + model.
- **Role-based model assignment** — Chat and Lookup use separate model connections so you can run lightweight models for lookups and heavier ones for deep conversations.
- **Knowledge Base (KB) personalization** — Analyzes past conversations to build a learning-preference profile that gets injected into lookup queries, making responses adapt to your style over time.
- **Conversation persistence & search** — All conversations are saved to disk automatically, survive restarts, and are searchable by title.
- **Wayland-first** — Built-in support for KDE Plasma Wayland via XDG Desktop Portals (GlobalShortcuts + Screenshot). Falls back to Electron's `globalShortcut` / `desktopCapturer` on X11, macOS, and Windows.
- **Privacy-first** — All data stays on your machine except AI API calls. Only a summarized learning-preference paragraph is sent alongside lookup queries. No telemetry, no accounts.

---

## Screenshots

| Chat window | Lookup popup |
|---|---|
| Full chat with sidebar navigation, inline expansions, and conversation search | Always-on-top popup after screen capture, showing OCR context and AI response |

---

## Architecture

```
Renderer (React 19)          Preload (contextBridge)        Main process (Node)
┌─────────────────┐         ┌──────────────────┐         ┌──────────────────────┐
│  App.tsx         │ ────── │  window.api.*     │ ────── │  index.ts            │
│  LookupApp.tsx   │  IPC   │  chatSend/Expand  │         │  provider.ts         │
│  Conversation.tsx│         │  lookup*          │         │  config.ts           │
│  Turn.tsx        │         │  conversation*    │         │  conversations.ts    │
│  ExpansionFrame  │         │  kb*              │         │  lookup/             │
│  Settings        │         └──────────────────┘         │    lookup.ts         │
│  useChatStreaming│                                        │    capture.ts       │
└─────────────────┘                                        │    window.ts        │
                                                            │    state.ts         │
  Shared (pure TS)                                          │  kb/               │
  ┌─────────────────┐                                       │    analysis.ts     │
  │  models.ts       │                                       │  services/          │
  │  conversation.ts │                                       │    global-shortcut  │
  │  expand-prompt.ts│                                       │    screen-capture   │
  │  prompts.ts      │                                       └──────────────────────┘
  └─────────────────┘
```

### Key modules

| Module | Role |
|---|---|
| `src/shared/models.ts` | Provider/role type registries, connection & config types — pure TS, no runtime deps |
| `src/shared/conversation.ts` | `ConversationState` model + pure helpers: tokenize, expand/insert/fold/unfold, serialize for API |
| `src/shared/expand-prompt.ts` | `buildExpandMessages` — constructs API messages for inline expansions with optional custom direction |
| `src/shared/prompts.ts` | All LLM-facing prompt strings (system prompts, context template, expand instructions, KB analysis) |
| `src/main/index.ts` | App lifecycle, main window, tray, streaming IPC handlers (chat-send, chat-expand, lookup-transfer) |
| `src/main/config.ts` | Config persistence (providers.json, settings.json), Wayland detection, hotkey registry, KB prompt I/O |
| `src/main/provider.ts` | Provider dispatch by role — resolves connection + model, routes to Google AI Studio / OpenAI-compatible / Ollama / OpenAI / OpenRouter |
| `src/main/conversations.ts` | Conversation CRUD on `{userData}/conversations/{id}.json`, list/search, KB-fed marking |
| `src/main/lookup/lookup.ts` | Hotkey entry point: capture screen → OCR → create popup session |
| `src/main/lookup/capture.ts` | Screen capture (portal-first on KDE Wayland) + tesseract.js OCR worker |
| `src/main/lookup/window.ts` | Lookup popup BrowserWindow, grow animation, ref-counted handlers |
| `src/main/lookup/state.ts` | `LookupSession` interface, session management, IPC helpers |
| `src/main/services/global-shortcut.ts` | XDG GlobalShortcuts D-Bus portal for Wayland |
| `src/main/services/screen-capture.ts` | Freedesktop Screenshot D-Bus portal for KDE Wayland (silent capture) |
| `src/main/kb/analysis.ts` | KB personalization pipeline: serialize conversations, build analysis messages, extract learning preferences |
| `src/main/kb/handlers.ts` | KB IPC handlers (kb-load-prompt, kb-analyze, kb-reanalyze) |
| `src/preload/index.ts` | `contextBridge` API — config, lookup, chat streaming, conversation persistence, KB channels |
| `src/renderer/src/Root.tsx` | Routes between `App` (main window) and `LookupApp` (popup) via `?role=lookup` |
| `src/renderer/src/App.tsx` | App shell: sidebar navigation with 5 views (Home, Chat, Knowledge Base, Look-Up Guide, Settings) |
| `src/renderer/src/LookupApp.tsx` | Lookup popup UI: OCR context panel, ask input, paste handling, transfer-to-chat, grow transitions |
| `src/renderer/src/hooks/useChatStreaming.ts` | Shared streaming hook — owns `ConversationState`, dispatches `chat-send`/`chat-expand`, auto-saves |
| `src/renderer/src/components/conversation/` | Conversation UI: message list (`Conversation.tsx`), turns (`Turn.tsx`), expansion frames (`ExpansionFrame.tsx`), context menu, expand prompt, search overlay |

### IPC channels

| Channel | Direction | Purpose |
|---|---|---|
| `chat-send` / `chat-chunk` / `chat-response` / `chat-error` | Renderer ↔ Main | Streaming chat messages (keyed by `requestId`) |
| `chat-expand` / `chat-expand-chunk` | Renderer ↔ Main | Streaming inline expansions |
| `chat-replace-conversation` | Main → Renderer | Hydrate transferred conversation (lookup → chat) |
| `lookup-trigger-grow` / `lookup-grow` | Lookup ↔ Main | Window grow animation on first ask |
| `lookup-transfer` | Lookup → Main | Send lookup conversation to chat window |
| `lookup-context` / `lookup-paste-text` / `lookup-paste-image` / `lookup-ocr-image` | Lookup ↔ Main | OCR context and paste handling |
| `lookup-input-changed` / `lookup-close` | Lookup → Main | Blur guard and close |
| `conversation-*` | Renderer ↔ Main | Conversation CRUD (save/load/delete/list/search) |
| `load-model-config` / `save-model-config` | Renderer ↔ Main | Provider config |
| `load-settings` / `save-settings` | Renderer ↔ Main | App settings (hotkey, tray behavior) |
| `kb-*` | Renderer ↔ Main | Knowledge Base analysis |

---

## Getting Started

### Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- **wl-clipboard** (Linux Wayland only) — `sudo apt install wl-clipboard`

### Development

```bash
npm install
npm run dev           # Launch with HMR (electron-vite)
```

### Commands

| Command | Description |
|---|---|
| `npm run dev` | Launch app with HMR |
| `npm run typecheck` | TypeScript check (`tsc --noEmit` for node + web) |
| `npm run lint` | ESLint + Prettier |
| `npm run format` | Prettier write across the repo |
| `npm run build` | Typecheck then `electron-vite build` |
| `npm run build:linux` | Build Linux AppImage |
| `npm run build:mac` | Build macOS DMG |
| `npm run build:win` | Build Windows NSIS installer |

### Configuration

Delta AI requires **your own API keys** to function. Open Settings → Models to configure:

1. **Add a connection** — pick a provider (Google AI Studio, OpenAI Compatible, OpenAI, Ollama, or OpenRouter) and enter your API key or host.
2. **Assign roles** — map the Chat and Lookup roles to a connection + model. A lightweight model is recommended for the Lookup role since no heavy reasoning is needed.

Configuration files live in `{userData}/config/`:
- `providers.json` — connections and role assignments
- `settings.json` — hotkey and close-to-tray preference

Conversations are stored in `{userData}/conversations/{id}.json`.

---

## Platform Support

| Platform | Hotkey | Screen capture | Clipboard |
|---|---|---|---|
| **Linux (KDE Wayland)** | XDG GlobalShortcuts portal | Screenshot portal (silent) | wl-paste |
| **Linux (GNOME/other Wayland)** | XDG GlobalShortcuts portal | `desktopCapturer.getSources()` | wl-paste |
| **Linux (X11)** | `globalShortcut.register()` | `desktopCapturer.getSources()` | Electron clipboard |
| **macOS** | `globalShortcut.register()` | `desktopCapturer.getSources()` | Electron clipboard |
| **Windows** | `globalShortcut.register()` | `desktopCapturer.getSources()` | Electron clipboard |

On Wayland, Electron's `clipboard.readText()` reads from the XWayland clipboard which is frequently out of sync with the native Wayland clipboard. Delta AI uses `wl-paste` to read the correct clipboard and falls back to Electron's API when `wl-paste` is unavailable.

---

## Privacy

- **Bring your own key (BYOK)** — API keys are stored locally in `{userData}/config/providers.json`.
- **All data stays local** except the AI API requests themselves.
- **KB personalization** sends only a condensed paragraph of inferred learning preferences — never raw conversation text — alongside lookup queries.
- **No telemetry, no analytics, no accounts.**

---

## Technology Stack

| Layer | Technology |
|---|---|
| Shell | Electron 39 |
| Build | electron-vite + Vite 7 |
| UI | React 19, TypeScript, vanilla CSS |
| OCR | tesseract.js (WASM) |
| AI Providers | Google AI Studio, OpenAI, OpenAI Compatible, Ollama, OpenRouter |
| Packaging | electron-builder (AppImage, DMG, NSIS) |
| Wayland | dbus-next (XDG Desktop Portals) |

---

## Project Structure

```
src/
  shared/         # Pure TypeScript: types, conversation model, prompts, expand logic
  main/           # Electron main process: lifecycle, IPC, config, OCR, KB, services
    lookup/       # Screen capture, OCR, popup window orchestration
    kb/           # Knowledge Base analysis and personalization
    services/     # D-Bus portal integrations (Wayland)
  preload/        # contextBridge API surface
  renderer/       # React 19 UI
    src/
      assets/     # CSS (base.css, chat.css, expand.css, lookup.css, settings.css)
      components/ # React components (Conversation, Turn, ExpansionFrame, Settings)
      hooks/      # useChatStreaming — shared streaming state management
      views/      # Home, Knowledge, LookupGuide, Settings views
docs/
  architecture.md # Detailed architecture reference
```

---

## License

MIT — see [LICENSE.md](LICENSE.md).
