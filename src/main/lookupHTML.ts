/**
 * Generate the inline HTML for the fullscreen transparent overlay.
 *
 * The visible 420x320 panel is positioned at (panelX, panelY) — these are
 * relative to the overlay's viewport (which covers the active monitor), and
 * are baked into the CSS so the panel is already in place before any script
 * runs.  No IPC round-trip needed for positioning.
 */
export function buildLookupHTML(panelX: number, panelY: number): string {
  const px = Math.max(0, panelX) + 'px'
  const py = Math.max(0, panelY) + 'px'

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      html, body {
        width: 100vw;
        height: 100vh;
        background: transparent;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      }
      /* Fullscreen transparent overlay — the compositor honours its origin
         (0,0).  The 420x320 popup panel is drawn inside it at the supplied
         cursor offset so the compositor can never reposition it.  The
         transparent backdrop passes clicks through to the window underneath;
         clicks on the panel itself are captured. */
      #panel {
        position: absolute;
        width: 420px;
        height: 320px;
        left: ${px};
        top: ${py};
        background: #1a1a1a;
        color: #e0e0e0;
        border-radius: 8px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        display: flex;
        flex-direction: column;
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
      .ai-response {
        font-size: 14px;
        line-height: 1.5;
        color: #e0e0e0;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .loading { color: #666; font-style: italic; }
      .error   { color: #ff6b6b; }
      .scroll::-webkit-scrollbar { width: 6px; }
      .scroll::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
    </style>
  </head>
  <body>
    <div id="panel">
      <div class="header">
        <span>Delta AI</span>
        <span class="close" onclick="window.api.lookupClose()">✕</span>
      </div>
      <div class="content">
        <div class="section-label">Extracted Text</div>
        <div id="extracted" class="extracted scroll">Waiting for OCR…</div>
        <div class="section-label">AI Response</div>
        <div id="response" class="ai-response scroll"><span class="loading">Waiting for response…</span></div>
      </div>
    </div>
    <script>
      var w = window.api;
      w.lookupOnOcr(function(text) {
        document.getElementById('extracted').textContent = text || '(No text extracted)';
      });
      w.lookupOnResponse(function(response) {
        var el = document.getElementById('response');
        el.innerHTML = '';
        el.className = 'ai-response scroll';
        el.textContent = response;
      });
      w.lookupOnError(function(err) {
        var el = document.getElementById('response');
        el.innerHTML = '';
        el.className = 'ai-response scroll error';
        el.textContent = err;
      });
    </script>
  </body>
</html>`
}
