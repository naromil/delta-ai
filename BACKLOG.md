# Backlog — maintained by Claude's weekly planner. Move items between sections to steer it.

## Routine (Claude may build these without asking)

- [x] Clear the Copy-label timer when a turn unmounts — `Turn.tsx` calls setState from a stray `setTimeout` after navigation

- [x] Open markdown links in the system browser — `Anchor` swallows every click today; needs the owner because it touches the navigation/`window-guards` security boundary
- [x] Syntax highlighting in code blocks — needs a new dependency (e.g. a highlighter) and must keep `data-src` offset anchors intact
- [x] Math (LaTeX) rendering — needs new dependencies (remark-math + a renderer) and changes the markdown → offset mapping
- [x] Light/dark theme setting — adds a field to the `settings.json` schema (light theme try to replicate the soothe feel of the dark one)
- [x] Image attachments in chat (multimodal models) — new IPC payloads, provider capability checks
- [ ] Have AI-based conversation title generation at first message.

- [x] Expansion: answer with the real context — a request carries only the system prompt and the enclosing text, so it never sees the user's question or earlier turns, and a nested expansion sees only its parent's answer; send the question, recent turns and the ancestor chain, and budget it (`applyContextBudget` only covers `chat-send`)
- [x] Expansion: fit the answer to the selection and the learner — plain Expand always asks for a bare definition, even for a whole sentence; choose define vs. explain from the selection, and give expand read-only `index*` memories so depth follows `index-learning.md` (it gets no memory today)
- [x] Expansion: make finished frames manageable — Retry and Dismiss exist only on errors, and the frame never shows the "Expand on…" prompt; add regenerate, remove, copy, re-ask with a different prompt, and show the prompt on the frame and folded pill
- [x] Expansion: faster ways to ask — one-click intents (Simpler, Example, Why, Compare, Deeper) stored in the existing `prompt` field, plus a floating bar on selection and a keyboard shortcut, so it no longer always takes a right-click
- [x] Expansion: accept more selections — a range must sit inside one markdown text node, so a selection crossing bold, inline code or a link is refused, and code blocks and formulas can't be targets; touches the offset-anchoring invariants in `lib/markdown.ts` and `rich-text.ts`
- [x] Expansion: suggested terms — lightly underline words in an answer that the document base suggests are new to the user, so one click expands them; needs a per-answer model pass or a term list, and must not get noisy.
- [x] Expansion: support expand a term multiple times. If there are multiple to select at one place, just have a pop-up list to choose from the expansions.
- [x] Expansion: in the expansion box, have a button to delete the expansion, and also display the question asked if not the default one.

## Proposed (needs the owner's OK — move to Routine to approve)

- [ ] Per-message timestamps — requires adding a field to the stored `Turn` format

## Ideas for the owner to consider (never built automatically)

- Per-conversation system prompt or persona
- Voice input and read-aloud
- Expansion: map of what you've explored — a view of every expanded term across conversations, showing repeats and how they connect, with a jump back to the source; fits "conversations are learning materials" and could reuse an earlier answer when a term comes back

## Rejected (Claude won't re-propose these)

- Pin or star conversations — changes the `ConversationMeta` sidecar format
- Export all conversations / import from a file — needs new IPC channels and a bulk file format
- Conversation history sidebar in the chat view — a layout redesign of the chat screen
- Quiz / flashcard mode built from the KB profile and history, with spaced repetition
- Expansion: dedicated `expand` model role — inline answers should appear almost immediately, but expand uses the chat or lookup model; a fast, cheap role falling back to the current one (new `RoleId`, needs a config-schema migration)
