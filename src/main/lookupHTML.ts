export const lookUpHTML = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        background: #1a1a1a;
        color: #e0e0e0;
        padding: 0;
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
      .loading {
        color: #666;
        font-style: italic;
      }
      .error {
        color: #ff6b6b;
      }
      .scroll::-webkit-scrollbar { width: 6px; }
      .scroll::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
    </style>
  </head>
  <body>
    <div class="header">
      <span>Delta AI</span>
      <span class="close" onclick="window.close()">✕</span>
    </div>
    <div class="content">
      <div class="section-label">Extracted Text</div>
      <div id="extracted" class="extracted scroll">Waiting for OCR…</div>
      <div class="section-label">AI Response</div>
      <div id="response" class="ai-response scroll"><span class="loading">Waiting for response…</span></div>
    </div>
    <script>
      const { ipcRenderer } = require('electron');
      ipcRenderer.on('ocr-result', (_e, text) => {
        const el = document.getElementById('extracted');
        el.textContent = text || '(No text extracted)';
      });
      ipcRenderer.on('ai-response', (_e, response) => {
        const el = document.getElementById('response');
        el.innerHTML = '';
        el.textContent = response;
      });
      ipcRenderer.on('ai-error', (_e, err) => {
        const el = document.getElementById('response');
        el.innerHTML = '';
        el.className = 'ai-response error';
        el.textContent = err;
      });
    </script>
  </body>
</html>`
