# Backlog — maintained by Claude's weekly planner. Move items between sections to steer it.

## Routine (Claude may build these without asking)

- [ ] Recent conversations on the Home view — past chats are reachable only through the Ctrl+K search modal; `conversation-list` already returns them sorted
- [ ] Delete the open conversation from the chat toolbar — the search modal refuses to delete the open chat, so there is no way to delete it at all
- [ ] Edit and resend a user message — common in chat apps; reuses the `replaceAssistantTurn` truncate-and-resend path
- [ ] Copy button on code blocks — copying a fenced block today means a manual selection that the context menu competes for
- [ ] Esc stops generation in the chat window — the lookup popup handles Escape, but the chat window needs a mouse click on Stop
- [ ] Keep the composer draft across view switches — `Conversation` unmounts on navigation and silently drops the typed text
- [ ] Make Ctrl+N / Ctrl+K work from every view — the listener lives in `Conversation.tsx`, so the shortcuts do nothing on Home, Knowledge or Settings
- [ ] Sync README with current behavior — it omits key sealing, says the KB prompt only reaches lookups, and lists `settings.json` as just hotkey + tray
- [ ] Unit tests for `main/context-budget.ts` and `services/atomic-file.ts` — fail-open budgeting and crash-safe writes are untested
- [ ] Clear the Copy-label timer when a turn unmounts — `Turn.tsx` calls setState from a stray `setTimeout` after navigation

## Proposed (needs the owner's OK — move to Routine to approve)

- [ ] Open markdown links in the system browser — `Anchor` swallows every click today; needs the owner because it touches the navigation/`window-guards` security boundary
- [ ] Syntax highlighting in code blocks — needs a new dependency (e.g. a highlighter) and must keep `data-src` offset anchors intact
- [ ] Math (LaTeX) rendering — needs new dependencies (remark-math + a renderer) and changes the markdown → offset mapping
- [ ] Conversation history sidebar in the chat view — a layout redesign of the chat screen
- [ ] Per-message timestamps — requires adding a field to the stored `Turn` format
- [ ] Light/dark theme setting — adds a field to the `settings.json` schema
- [ ] Pin or star conversations — changes the `ConversationMeta` sidecar format
- [ ] Export all conversations / import from a file — needs new IPC channels and a bulk file format

## Ideas for the owner to consider (never built automatically)

- Image attachments in chat (multimodal models) — new IPC payloads, provider capability checks
- Quiz / flashcard mode built from the KB profile and history, with spaced repetition
- Per-conversation system prompt or persona
- Voice input and read-aloud
- Branching history: keep earlier answers when regenerating and let the user switch between them

## Rejected (Claude won't re-propose these)
