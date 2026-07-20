const CSS_STYLES = `<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    height: 100%;
    transition: height 0.35s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background: #1a1a1a;
    color: #e0e0e0;
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    user-select: text;
  }
  .header {
    background: #2a2a2a;
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 600;
    color: #aaa;
    border-bottom: 1px solid #333;
    display: flex;
    justify-content: space-between;
    align-items: center;
    -webkit-app-region: drag;
    flex-shrink: 0;
  }
  .header .close {
    -webkit-app-region: no-drag;
    cursor: pointer;
    color: #888;
    font-size: 18px;
    line-height: 1;
  }
  .header .close:hover { color: #fff; }
  .content {
    flex: 1;
    overflow-y: auto;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
  }
  .section-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #666;
    margin-bottom: 4px;
    font-weight: 600;
  }
  .extracted {
    font-size: 13px;
    color: #ccc;
    background: #222;
    border-radius: 6px;
    padding: 8px 10px;
    margin-bottom: 6px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 80px;
    overflow-y: auto;
    border: 1px solid transparent;
    transition: border-color 0.2s;
  }
  .extracted.hint {
    color: #777;
    font-style: italic;
  }
  .extracted.flash {
    border-color: rgba(60, 118, 185, 0.45);
    box-shadow: inset 0 0 0 1px rgba(60, 118, 185, 0.18);
  }
  .paste-tip {
    font-size: 11px;
    color: #555;
    margin-bottom: 12px;
  }
  .ask-wrap {
    flex-shrink: 0;
    margin-bottom: 8px;
  }
  .ask {
    width: 100%;
    background: #232323;
    border: 1px solid #333;
    border-radius: 8px;
    color: #e0e0e0;
    font-size: 14px;
    font-family: inherit;
    padding: 10px 12px;
    outline: none;
  }
  .ask:focus { border-color: #4a90d9; box-shadow: 0 0 0 2px rgba(74,144,217,0.2); }
  .ask::placeholder { color: #666; }
  .conversation {
    display: none;
    flex: 1;
    overflow-y: auto;
    flex-direction: column;
    gap: 10px;
    padding-bottom: 4px;
  }
  .conversation.visible { display: flex; }
  .turn {
    font-size: 15px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    padding: 8px 10px;
    border-radius: 8px;
  }
  .turn.user {
    background: #2c3a4a;
    color: #d6e4ff;
    align-self: flex-end;
    max-width: 92%;
  }
  .turn.ai {
    background: #222;
    color: #e0e0e0;
    align-self: flex-start;
    max-width: 96%;
  }
  .turn.loading { color: #666; font-style: italic; }
  .turn.error   { color: #ff6b6b; }
  .scroll::-webkit-scrollbar { width: 6px; }
  .scroll::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }

  /* ---- Infinite-query expansion ---- */
  .turn.ai .word { cursor: text; }
  /* Inline expansion frame. The frame wraps the explanation text and
      participates in the parent paragraph flow (no block boxes). */
  .frame.expanded {
    display: inline;
    background: rgba(74, 144, 217, 0.06);
    border: 1px solid rgba(74, 144, 217, 0.55);
    border-radius: 4px;
    padding: 2px 4px;
    margin: 0 2px;
    vertical-align: baseline;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
    transition: opacity 0.25s ease;
  }
  .frame.loading { border-color: rgba(120, 120, 120, 0.55); background: rgba(120, 120, 120, 0.06); }
  .frame.loading .frame-inner { color: #888; font-style: italic; }
  .frame.error { border-color: rgba(255, 107, 107, 0.55); background: rgba(255, 107, 107, 0.05); }
  .frame.error .frame-inner { color: #ff6b6b; }
  .frame.error .fold-toggle { display: none; }
  .frame-inner {
    display: inline;
    font-size: 15px;
    line-height: 1.5;
    white-space: normal;
    word-break: break-word;
  }
  .frame-inner p { display: inline; margin: 0; }
  .frame-inner p + p::before { content: ' '; }
  /* Click target to fold/unfold an expansion frame.
      Selector with space means: .fold-toggle that is a descendant of .frame. */
  .frame .fold-toggle {
    display: inline;
    margin-left: 4px;
    margin-right: 2px;
    font-size: 12px;
    color: #4a90d9;
    cursor: pointer;
    vertical-align: baseline;
    user-select: none;
    line-height: 1.5;
    padding: 2px;
  }
  .frame .fold-toggle:hover { color: #fff; }
  /* Folded queried-word pill. Clicking re-opens the cached frame. */
  .queried {
    background: rgba(74, 144, 217, 0.18);
    border-radius: 2px;
    padding: 0 2px;
    cursor: pointer;
    vertical-align: baseline;
  }
  .queried:hover { background: rgba(74, 144, 217, 0.32); }

  /* Custom context menu */
  #ctxMenu {
    position: fixed;
    z-index: 1000;
    background: #2a2a2a;
    border: 1px solid #333;
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    padding: 4px 0;
    font-size: 13px;
    min-width: 140px;
    display: none;
  }
  #ctxMenu.visible { display: block; }
  #ctxMenu .item {
    padding: 6px 14px;
    cursor: pointer;
    color: #ddd;
  }
  #ctxMenu .item:hover { background: #3a3a3a; color: #fff; }
  #ctxMenu .item.disabled {
    color: #555;
    cursor: default;
  }
  #ctxMenu .item.disabled:hover { background: transparent; color: #555; }
  #ctxMenu .sep { height: 1px; background: #333; margin: 4px 0; }
</style>`

export const lookUpHTML = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    ${CSS_STYLES}
  </head>
  <body>
    <div class="header">
      <span>Delta AI</span>
      <span class="close" onclick="window.api.lookupClose()">✕</span>
    </div>
    <div class="content">
      <div class="section-label">Context</div>
      <div id="extracted" class="extracted hint scroll">Waiting for OCR…</div>
      <div class="paste-tip">Ctrl+V to paste text or an image as context.</div>
      <div class="ask-wrap">
        <input id="ask" class="ask" type="text" placeholder="Ask DeltaAI…" autocomplete="off" />
      </div>
      <div id="conversation" class="conversation scroll"></div>
    </div>
    <div id="ctxMenu">
      <div class="item" data-action="expand">Expand</div>
      <div class="sep"></div>
      <div class="item" data-action="copy">Copy</div>
      <div class="item" data-action="select-all">Select All</div>
    </div>
    <script>
      var w = window.api;
      var askEl = document.getElementById('ask');
      var convEl = document.getElementById('conversation');
      var extractedEl = document.getElementById('extracted');
      var ctxMenu = document.getElementById('ctxMenu');

      var contextReady = false;
      var originalContext = '';
      var originalQuestion = '';
      var lastAnswer = '';
      var nextExpansionId = 1;
      var expansionCache = {};

      var flashTimer = null;
      var ctxMenuTarget = null;
      var ctxSelection = '';
      var ctxWordSpan = null;
      var ctxRange = null;

      /* ---- Helpers ---- */

      function getInnermostFrame(node) {
        var el = node.nodeType === 3 ? node.parentElement : node;
        return el ? el.closest('.frame[data-expansion-id]') : null;
      }

      function selectionSpansFrames(range) {
        if (!range) return false;
        var startFrame = getInnermostFrame(range.startContainer);
        var endFrame = getInnermostFrame(range.endContainer);
        return startFrame !== endFrame;
      }

      /* ---- Markdown / token helpers ---- */

      function flattenMarkdown(text) {
        text = text.replace(/^#{1,6}\\s+/gm, '');
        text = text.replace(/\\*{1,3}([^*]+)\\*{1,3}/g, '$1');
        text = text.replace(/_{1,3}([^_]+)_{1,3}/g, '$1');
        text = text.replace(/\\x60([^\\x60]+)\\x60/g, '$1');
        text = text.replace(/\\[([^\\]]+)\\]\\([^)]+\\)/g, '$1');
        text = text.replace(/^[\\s]*[-*+]\\s+/gm, '\u00b7 ');
        text = text.replace(/^[\\s]*\\d+\\.\\s+/gm, '\u00b7 ');
        text = text.replace(/^>\\s+/gm, '');
        text = text.replace(/^[-*_]{3,}\\s*$/gm, '');
        return text;
      }

      function tokenizeText(text) {
        var parts = text.split(/(\\s+)/);
        var frag = document.createDocumentFragment();
        for (var i = 0; i < parts.length; i++) {
          var part = parts[i];
          if (part === '') continue;
          if (/^\\s+$/.test(part)) {
            frag.appendChild(document.createTextNode(part));
          } else {
            var span = document.createElement('span');
            span.className = 'word';
            span.textContent = part;
            frag.appendChild(span);
          }
        }
        return frag;
      }

      function renderInline(text) {
        var flattened = flattenMarkdown(text);
        var paragraphs = flattened.split(/\\n{2,}/);
        var frag = document.createDocumentFragment();
        for (var i = 0; i < paragraphs.length; i++) {
          var p = paragraphs[i].trim();
          if (!p) continue;
          if (i > 0) {
            frag.appendChild(document.createElement('br'));
          }
          frag.appendChild(tokenizeText(p));
        }
        return frag;
      }

      /* ---- Turn rendering ---- */

      function addTurn(kind, text) {
        var el = document.createElement('div');
        el.className = 'turn ' + kind;
        el.textContent = text;
        convEl.appendChild(el);
        convEl.scrollTop = convEl.scrollHeight;
        return el;
      }

      function replaceLastAi(text, extraClass) {
        var turns = convEl.querySelectorAll('.turn.ai');
        var el = turns.length ? turns[turns.length - 1] : addTurn('ai', text);
        if (extraClass === 'error') {
          el.textContent = text;
        } else {
          el.textContent = '';
          el.appendChild(renderInline(text));
        }
        el.className = 'turn ai' + (extraClass ? ' ' + extraClass : '');
        convEl.scrollTop = convEl.scrollHeight;
      }

      /* ---- Custom context menu ---- */

      function showCtxMenu(x, y, canExpand) {
        var expandItem = ctxMenu.querySelector('[data-action="expand"]');
        expandItem.classList.toggle('disabled', !canExpand);
        ctxMenu.style.left = x + 'px';
        ctxMenu.style.top = y + 'px';
        ctxMenu.classList.add('visible');
      }

      function hideCtxMenu() {
        ctxMenu.classList.remove('visible');
        ctxMenuTarget = null;
        ctxSelection = '';
        ctxWordSpan = null;
        ctxRange = null;
      }

      ctxMenu.addEventListener('click', function (e) {
        var item = e.target.closest('.item');
        if (!item || item.classList.contains('disabled')) return;
        var action = item.dataset.action;
        // Snapshot both pieces of cached right-click state BEFORE hideCtxMenu()
        // nulls them — otherwise expandSelection falls back to window.getSelection()
        // anchored at the menu-item click coords (deterministically the last word).
        var selection = ctxSelection;
        var wordSpan = ctxWordSpan;
        var cachedRange = ctxRange;
        hideCtxMenu();
        if (action === 'expand') {
          expandSelection(selection, wordSpan, cachedRange);
        } else if (action === 'copy') {
          // Restore the cached right-click range before copying — the menu
          // click collapsed the DOM selection and hideCtxMenu() nulled the
          // globals, but we still have the local cachedRange snapshot.
          if (cachedRange) {
            var sel_ = window.getSelection();
            sel_.removeAllRanges();
            sel_.addRange(cachedRange);
          } else if (selection) {
            // Fallback: no range cached but we have the text string.
            var ta = document.createElement('textarea');
            ta.value = selection;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            return;
          }
          document.execCommand('copy');
        } else if (action === 'select-all') {
          var range = document.createRange();
          range.selectNodeContents(convEl);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      });

      document.addEventListener('contextmenu', function (e) {
        if (e.target.closest('.fold-toggle') || e.target.closest('#ctxMenu')) return;
        var turnEl = e.target.closest('.turn.ai');
        if (!turnEl || turnEl.classList.contains('error')) return;
        e.preventDefault();

        var sel = window.getSelection();
        var selectedText = sel.toString().trim();
        ctxMenuTarget = e.target;

        if (selectedText) {
          ctxSelection = selectedText;
          ctxWordSpan = null;
          // Snapshot the live range at right-click time. The range will be
          // stale by the time the menu-item click handler runs (the menu
          // mousedown can collapse the selection, and caretRangeFromPoint
          // from prior right-clicks may have shifted it).
          if (sel.rangeCount > 0) {
            ctxRange = sel.getRangeAt(0).cloneRange();
          }
          // Disable Expand when the selection spans multiple frames —
          // deleteContents() on a cross-frame Range would corrupt the DOM.
          var canExpand = !selectionSpansFrames(ctxRange);
          showCtxMenu(e.clientX, e.clientY, canExpand);
          return;
        }

        if (document.caretRangeFromPoint) {
          var cr = document.caretRangeFromPoint(e.clientX, e.clientY);
          if (cr && cr.startContainer) {
            var startEl =
              cr.startContainer.nodeType === 3
                ? cr.startContainer.parentElement
                : cr.startContainer;
            if (startEl) {
              if (startEl.classList.contains('queried')) {
                sel.removeAllRanges();
                var r = document.createRange();
                r.selectNodeContents(startEl);
                sel.addRange(r);
                ctxSelection = startEl.textContent.trim();
                ctxWordSpan = startEl;
                ctxRange = r.cloneRange();
                showCtxMenu(e.clientX, e.clientY, true);
                return;
              }
              if (startEl.classList.contains('word')) {
                sel.removeAllRanges();
                var r = document.createRange();
                r.selectNodeContents(startEl);
                sel.addRange(r);
                ctxSelection = startEl.textContent.trim();
                ctxWordSpan = startEl;
                ctxRange = r.cloneRange();
                showCtxMenu(e.clientX, e.clientY, true);
                return;
              }
            }
          }
        }

        ctxSelection = '';
        showCtxMenu(e.clientX, e.clientY, false);
      });

      document.addEventListener('click', function (e) {
        if (!ctxMenu.contains(e.target)) hideCtxMenu();
      });

      /* ---- Triple-click: select innermost frame contents ---- */
      document.addEventListener('mousedown', function (e) {
        if (e.detail === 3 && e.button === 0) {
          var frame = e.target.closest('.frame[data-expansion-id]');
          if (frame) {
            e.preventDefault();
            var inner = frame.querySelector('.frame-inner') || frame;
            var range = document.createRange();
            range.selectNodeContents(inner);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          }
        }
      });

      /* ---- Copy shortcut (Ctrl+C) ---- */
      document.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
          // Only copy if selection exists in the conversation area.
          var active = document.activeElement;
          if (active && (active === askEl || active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) return;
          var sel = window.getSelection();
          if (sel && sel.toString().trim()) {
            document.execCommand('copy');
          }
        }
      });

      /* ---- Expansion ---- */

      function expandSelection(selection, cachedWordSpan, cachedRange) {
        if (!selection) return;

        var sel = window.getSelection();
        var anchor = sel.anchorNode;
        var anchorEl = anchor && anchor.nodeType === 3 ? anchor.parentElement : anchor;

        // If the right-click was on an existing .queried pill, prefer the
        // cached word span (which is the pill itself) over the live selection
        // anchor — the live anchor reflects the menu-item click, not the pill.
        var cachedQueried =
          cachedWordSpan && cachedWordSpan.classList.contains('queried')
            ? cachedWordSpan
            : null;
        var queriedPill =
          cachedQueried ||
          (cachedWordSpan
            ? null
            : anchorEl
              ? anchorEl.closest('.queried')
              : null);
        if (queriedPill) {
          var pid = Number(queriedPill.dataset.expansionId);
          if (expansionCache[pid]) {
            reexpandExpansion(pid);
            sel.removeAllRanges();
            return;
          }
        }

        var id = nextExpansionId++;

        var parentEl = queriedPill
          ? queriedPill.closest('[data-expansion-id]')
          : (cachedWordSpan
              ? cachedWordSpan.closest('[data-expansion-id]')
              : anchorEl
                ? anchorEl.closest('[data-expansion-id]')
                : null);
        var parentAnswer = '';
        if (parentEl && expansionCache[Number(parentEl.dataset.expansionId)]) {
          parentAnswer = expansionCache[Number(parentEl.dataset.expansionId)].cachedText;
        } else {
          parentAnswer = lastAnswer;
        }

        expansionCache[id] = { frame: null, cachedText: '', originalText: selection };

        var frameOuter = document.createElement('span');
        frameOuter.className = 'frame expanded loading';
        frameOuter.dataset.expansionId = id;

        var frameInner = document.createElement('span');
        frameInner.className = 'frame-inner';
        frameInner.textContent = 'Thinking\u2026';
        frameOuter.appendChild(frameInner);

        var foldBtn = document.createElement('span');
        foldBtn.className = 'fold-toggle';
        foldBtn.textContent = '\u25be';
        foldBtn.title = 'Fold';
        foldBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          foldExpansion(id);
        });
        frameOuter.appendChild(foldBtn);

        // Prefer the cached word span snapshotted at right-click time:
        // window.getSelection() at this point reflects the menu-item click
        // (which lands near the menu, often the last word of the paragraph),
        // not the original right-click target.
        var wordSpan =
          cachedWordSpan || ctxWordSpan || (anchorEl ? anchorEl.closest('.word') : null);
        ctxWordSpan = null;

        // Prefer the cached range snapshotted at right-click time for the
        // multi-word insertion path. The live window.getSelection() range may
        // have collapsed (menu mousedown) or shifted (stale caretRangeFromPoint).
        var range = cachedRange || ctxRange || (sel.rangeCount > 0 ? sel.getRangeAt(0) : null);
        ctxRange = null;

        // If the selection matches a single word span, replace it directly.
        // For multi-word selections or no word match, use range insertion.
        if (wordSpan && wordSpan.parentNode && selection === wordSpan.textContent.trim()) {
          wordSpan.parentNode.replaceChild(frameOuter, wordSpan);
        } else if (range) {
          // Defensive: refuse to delete across frame boundaries — would
          // corrupt the DOM and invalidate the expansion cache.
          if (selectionSpansFrames(range)) return;
          range.deleteContents();
          range.insertNode(frameOuter);
        } else {
          // No usable target — abort rather than land the frame in the wrong place.
          return;
        }
        sel.removeAllRanges();

        expansionCache[id].frame = frameOuter;

        // Animate the frame in (fade from opacity 0 to 1).
        animateFrameIn(frameOuter);

        // For nested expansions (inside a frame), don't send the top-level
        // context/question — only the parent answer text is relevant.
        var isNested = parentAnswer !== lastAnswer;
        w.lookupExpand({
          context: isNested ? '' : originalContext,
          question: isNested ? '' : originalQuestion,
          answer: parentAnswer,
          selection: selection,
          expansionId: id
        });
      }

      function foldExpansion(id) {
        var cached = expansionCache[id];
        if (!cached) return;
        var frame = cached.frame;
        if (!frame || !frame.parentNode) return;

        var pill = document.createElement('span');
        pill.className = 'queried';
        pill.textContent = cached.originalText;
        pill.dataset.expansionId = id;
        pill.title = 'Click to re-expand';
        pill.addEventListener('click', function (e) {
          e.stopPropagation();
          reexpandExpansion(id);
        });

        // Fade out the frame before swapping to the pill.
        animateFrameOut(frame, function () {
          if (frame.parentNode) {
            frame.parentNode.replaceChild(pill, frame);
          }
        });
        // Keep the detached frame in the cache (including any nested
        // sub-frames) so re-expand can re-attach it intact.
      }

      function reexpandExpansion(id) {
        var cached = expansionCache[id];
        if (!cached || !cached.cachedText) return;

        var pill = document.querySelector('.queried[data-expansion-id="' + id + '"]');
        if (!pill) return;

        if (cached.frame) {
          // Frame DOM was preserved on fold — re-attach it (nested
          // sub-frames come back intact).
          pill.parentNode.replaceChild(cached.frame, pill);
          animateFrameIn(cached.frame);
          return;
        }

        // Fallback: recreate from cached text (no saved frame).
        var frameOuter = document.createElement('span');
        frameOuter.className = 'frame expanded';
        frameOuter.dataset.expansionId = id;

        var frameInner = document.createElement('span');
        frameInner.className = 'frame-inner';
        frameInner.appendChild(renderInline(cached.cachedText));
        frameOuter.appendChild(frameInner);

        var foldBtn = document.createElement('span');
        foldBtn.className = 'fold-toggle';
        foldBtn.textContent = '\u25be';
        foldBtn.title = 'Fold';
        foldBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          foldExpansion(id);
        });
        frameOuter.appendChild(foldBtn);

        pill.parentNode.replaceChild(frameOuter, pill);
        cached.frame = frameOuter;
        animateFrameIn(frameOuter);
      }

      /* ---- Animation helpers ---- */

      function animateFrameIn(frame) {
        frame.style.opacity = '0';
        frame.style.transition = 'none';
        void frame.offsetHeight;
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            frame.style.opacity = '1';
            frame.style.transition = '';
          });
        });
      }

      function animateFrameOut(frame, callback) {
        frame.style.opacity = '0';
        frame.style.transition = 'opacity 0.25s ease';
        setTimeout(function () {
          if (callback) callback();
        }, 280);
      }

      /* ---- Event handlers ---- */

      window.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          if (ctxMenu.classList.contains('visible')) {
            hideCtxMenu();
            return;
          }
          e.preventDefault();
          w.lookupClose();
        }
      });

      window.addEventListener('load', function () {
        askEl.focus();
      });

      askEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (!contextReady) {
            flashHint('Context is still being prepared\u2026');
            return;
          }
          var q = askEl.value.trim();
          var displayQ = q || 'summarize';
          originalQuestion = displayQ;
          addTurn('user', displayQ);
          var loadingEl = addTurn('ai', 'Thinking\u2026');
          loadingEl.classList.add('loading');
          askEl.value = '';
          w.lookupAsk(q);
        }
      });

      askEl.addEventListener('input', function () {
        w.lookupInputChanged(askEl.value.length > 0);
      });

      /* ---- Paste handling ---- */
      document.addEventListener('paste', function (e) {
        e.preventDefault();
        var cd = e.clipboardData;
        if (!cd) return;

        var imageItem = null;
        for (var i = 0; i < cd.items.length; i++) {
          var it = cd.items[i];
          if (it.kind === 'file' && it.type.indexOf('image/') === 0) {
            imageItem = it;
            break;
          }
        }
        if (imageItem) {
          readFileAsBase64(imageItem.getAsFile(), function (b64) {
            if (b64) w.lookupPasteImage(b64);
          });
          return;
        }

        var text = cd.getData('text/plain');
        if (text && text.trim()) {
          w.lookupPasteText(text);
        }
      });

      function readFileAsBase64(file, cb) {
        if (!file) { cb(null); return; }
        var reader = new FileReader();
        reader.onload = function () {
          var arr = new Uint8Array(reader.result);
          var bin = '';
          for (var i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
          cb(btoa(bin));
        };
        reader.onerror = function () { cb(null); };
        reader.readAsArrayBuffer(file);
      }

      /* ---- Context / stream handlers ---- */
      w.lookupOnContext(function (state) {
        contextReady = state.status === 'ready';
        if (state.status === 'ready') {
          if (state.text) {
            originalContext = state.text;
            extractedEl.textContent = state.text;
            extractedEl.classList.remove('hint');
          } else {
            extractedEl.textContent = state.hint || '(No context)';
            extractedEl.classList.add('hint');
          }
        } else {
          extractedEl.textContent = state.hint || 'Processing\u2026';
          extractedEl.classList.add('hint');
        }
        flashHint(null);
      });

      w.lookupOnChunk(function (text) {
        lastAnswer = text;
        var turns = convEl.querySelectorAll('.turn.ai');
        var el = turns.length ? turns[turns.length - 1] : addTurn('ai', '');
        // Use plain text during streaming so expansion frames in the DOM are
        // not destroyed on every chunk. Tokenization happens once in
        // replaceLastAi (called from lookupOnResponse) after streaming ends.
        el.textContent = text;
        el.classList.remove('loading');
        convEl.scrollTop = convEl.scrollHeight;
      });

      w.lookupOnResponse(function (response) {
        lastAnswer = response;
        replaceLastAi(response, '');
      });

      w.lookupOnError(function (err) {
        var aiTurns = convEl.querySelectorAll('.turn.ai');
        if (aiTurns.length) {
          replaceLastAi(err, 'error');
        } else {
          extractedEl.textContent = err;
          extractedEl.classList.remove('hint');
        }
      });

      w.lookupOnGrow(function (width, height) {
        document.documentElement.style.transition =
          'height 0.35s cubic-bezier(0.2, 0.8, 0.2, 1)';
        document.body.style.transition =
          'height 0.35s cubic-bezier(0.2, 0.8, 0.2, 1)';
        document.documentElement.style.height = height + 'px';
        document.body.style.height = height + 'px';
        convEl.classList.add('visible');
        convEl.scrollTop = convEl.scrollHeight;
        setTimeout(function () { askEl.focus(); }, 360);
      });

      w.lookupOnExpandChunk(function (chunk) {
        var id = chunk.expansionId;
        var cached = expansionCache[id];
        if (!cached) return;

        if (chunk.error) {
          var frame = cached.frame;
          if (frame) {
            frame.classList.remove('loading');
            frame.classList.add('error');
            var inner = frame.querySelector('.frame-inner');
            if (inner) inner.textContent = chunk.error;
          }
          cached.cachedText = chunk.error;
          return;
        }

        var text = chunk.text || '';
        cached.cachedText = text;
        var frame = cached.frame;
        if (!frame) return;

        var inner = frame.querySelector('.frame-inner');
        if (inner) {
          inner.textContent = '';
          inner.appendChild(renderInline(text));
        }
        frame.classList.remove('loading');
      });

      function flashHint(msg) {
        if (msg) {
          extractedEl.textContent = msg;
          extractedEl.classList.add('hint');
        }
        extractedEl.classList.add('flash');
        if (flashTimer) clearTimeout(flashTimer);
        flashTimer = setTimeout(function () {
          extractedEl.classList.remove('flash');
        }, 600);
      }
    </script>
  </body>
</html>`
