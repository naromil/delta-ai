# Backlog — maintained by Claude's weekly planner. Move items between sections to steer it.

## Routine (Claude may build these without asking)

- [ ] Have AI-based conversation title generation at first message.
- [x] Surface autosave failures in the chat — `saveConversationState` only `console.warn`s a failed `conversation-save`, so a chat can silently fail to persist
- [x] Show an error when OCR of a pasted image fails in the grown look-up — `LookupApp.tsx` drops `result.error`, so the spinner just stops and nothing happens
- [x] Ignore Enter during IME composition in the search modal and the Knowledge re-analyze field — Ctrl/Cmd+K opens the highlighted chat mid-composition for CJK input
- [x] List the keyboard shortcuts in the Look-up Guide view — Ctrl/Cmd+N, K, E, Shift+E and Esc-to-stop exist but are undiscoverable
- [ ] Fix stale Look-up Guide text — it points to a "chat sidebar" that doesn't exist, hardcodes Ctrl+Shift+D instead of the configured hotkey, and describes Expand as definition-only
- [ ] Ctrl/Cmd+, opens Settings — the standard desktop shortcut is missing from the app-wide handler in `App.tsx`
- [ ] Catch rejected `loadSettings`/`getHotkeyStatus` reads in the Look-up Guide and Settings views (and drop the redundant casts on the already-typed `loadSettings`) — a failed read leaves the mode picker unloaded with an unhandled rejection
- [ ] Unit-test `saveConversationState` in `hooks/chat/persistence.ts` — the autosave skip rules (no/blank turns, lookup source, finalized loading expansions) have no coverage
- [ ] Unit-test `formatRelativeTime` in `lib/format.ts` — the Home recents labels have untested 1m/1h/24h/7d boundaries

## Proposed (needs the owner's OK — move to Routine to approve)

- [ ] Per-message timestamps — requires adding a field to the stored `Turn` format
- [ ] Show which model produced each answer — adds a field to the stored `Turn` format
- [ ] Jump to the matching message when opening a search result — `conversation-search` results would need a turn id (IPC contract change)
- [ ] Copy a whole conversation as markdown to the clipboard — needs a new IPC channel or moving the export renderer into `shared/`
- [ ] Remember the main window's size and position — adds a field to the `settings.json` schema
- [ ] Fork a conversation from a message — a new UX concept that creates a second record from an existing one; the owner should pick the entry point

## Ideas for the owner to consider (never built automatically)

- Per-conversation system prompt or persona
- Voice input and read-aloud
- Expansion: map of what you've explored — a view of every expanded term across conversations, showing repeats and how they connect, with a jump back to the source; fits "conversations are learning materials" and could reuse an earlier answer when a term comes back
- Quick model switcher in the chat composer — pick a different model for one conversation without reassigning the chat role
- Saved prompts / snippets — reusable questions insertable from the composer

## Rejected (Claude won't re-propose these)

- Pin or star conversations — changes the `ConversationMeta` sidecar format
- Export all conversations / import from a file — needs new IPC channels and a bulk file format
- Conversation history sidebar in the chat view — a layout redesign of the chat screen
- Quiz / flashcard mode built from the KB profile and history, with spaced repetition
- Expansion: dedicated `expand` model role — inline answers should appear almost immediately, but expand uses the chat or lookup model; a fast, cheap role falling back to the current one (new `RoleId`, needs a config-schema migration)
