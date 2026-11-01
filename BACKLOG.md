# Backlog — maintained by Claude's weekly planner. Move items between sections to steer it.

## Routine (Claude may build these without asking)

- [ ] Clear the Copy-label timer when a turn unmounts — `Turn.tsx` calls setState from a stray `setTimeout` after navigation

- [ ] Open markdown links in the system browser — `Anchor` swallows every click today; needs the owner because it touches the navigation/`window-guards` security boundary
- [ ] Syntax highlighting in code blocks — needs a new dependency (e.g. a highlighter) and must keep `data-src` offset anchors intact
- [ ] Math (LaTeX) rendering — needs new dependencies (remark-math + a renderer) and changes the markdown → offset mapping
- [ ] Light/dark theme setting — adds a field to the `settings.json` schema (light theme try to replicate the soothe feel of the dark one)
- [ ] Image attachments in chat (multimodal models) — new IPC payloads, provider capability checks
- [ ] Have AI-based conversation title generation at first message.

## Proposed (needs the owner's OK — move to Routine to approve)

- [ ] Per-message timestamps — requires adding a field to the stored `Turn` format

## Ideas for the owner to consider (never built automatically)

- Per-conversation system prompt or persona
- Voice input and read-aloud

## Rejected (Claude won't re-propose these)

Conversations are treated as learning materials only and the history can be visualized in better forms in the future.

- Pin or star conversations — changes the `ConversationMeta` sidecar format
- Export all conversations / import from a file — needs new IPC channels and a bulk file format
- Conversation history sidebar in the chat view — a layout redesign of the chat screen
- Branching history: keep earlier answers when regenerating and let the user switch between them
- Quiz / flashcard mode built from the KB profile and history, with spaced repetition