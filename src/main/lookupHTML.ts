export const lookUpHTML = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
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
        margin-bottom: 12px;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 80px;
        overflow-y: auto;
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
        font-size: 14px;
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
    </style>
  </head>
  <body>
    <div class="header">
      <span>Delta AI</span>
      <span class="close" onclick="window.api.lookupClose()">✕</span>
    </div>
    <div class="content">
      <div class="section-label">Extracted Text</div>
      <div id="extracted" class="extracted scroll">Waiting for OCR…</div>
      <div class="ask-wrap">
        <input id="ask" class="ask" type="text" placeholder="Ask DeltaAI…" autocomplete="off" />
      </div>
      <div id="conversation" class="conversation scroll"></div>
    </div>
    <script>
      var w = window.api;
      var ocrText = '';
      var askEl = document.getElementById('ask');
      var convEl = document.getElementById('conversation');
      var extractedEl = document.getElementById('extracted');

      // Focus the input by default.
      window.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          w.lookupClose();
        }
      });

      window.addEventListener('load', function () {
        askEl.focus();
      });

      // Enter (without shift) sends the question.
      askEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          var q = askEl.value.trim();
          if (!q) return;
          addTurn('user', q);
          var loadingEl = addTurn('ai', 'Thinking…');
          loadingEl.classList.add('loading');
          askEl.value = '';
          w.lookupAsk(q);
        }
      });

      w.lookupOnOcr(function (text) {
        ocrText = text || '';
        extractedEl.textContent = ocrText || '(No text extracted)';
      });

      w.lookupOnResponse(function (response) {
        replaceLastAi(response, '');
      });

      w.lookupOnError(function (err) {
        replaceLastAi(err, 'error');
      });

      // Main tells us to grow the window so the conversation is visible.
      w.lookupOnGrow(function (width, height) {
        document.documentElement.style.transition =
          'height 0.35s cubic-bezier(0.2, 0.8, 0.2, 1)';
        document.body.style.transition =
          'height 0.35s cubic-bezier(0.2, 0.8, 0.2, 1)';
        document.documentElement.style.height = height + 'px';
        document.body.style.height = height + 'px';
        convEl.classList.add('visible');
        convEl.scrollTop = convEl.scrollHeight;
        // Keep the input focused after the grow animation.
        setTimeout(function () { askEl.focus(); }, 360);
      });

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
        el.textContent = text;
        el.className = 'turn ai' + (extraClass ? ' ' + extraClass : '');
        convEl.scrollTop = convEl.scrollHeight;
      }
    </script>
  </body>
</html>`
