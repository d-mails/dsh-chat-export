/*
 * DSH Chat Export client module.
 *
 * Adds an additive "Export chat" action to the Session header. A single dialog
 * lets the user pick any conversation, choose the format (Markdown / HTML /
 * PDF), toggle thinking and tool-call inclusion, and pick whole turns. Export
 * is local: the browser reads the same-origin host routes and saves the file.
 *
 * The PDF path rasterizes the exported HTML in the browser (SVG foreignObject
 * -> canvas -> JPEG pages -> a small dependency-free PDF writer), so CJK text
 * renders with system fonts and no server-side tool is required.
 */
window.__ModuleLoader__.load({
  id: 'dsh-chat-export',
  factory(require) {
    const React = require('react');
    const { jsx, jsxs } = require('react/jsx-runtime');
    const ReactDOM = require('react-dom');
    const { useEffect, useRef, useState } = React;
    const useLocaleStore = typeof React.useSyncExternalStore === 'function'
      ? React.useSyncExternalStore
      : () => {};

    const I18N_NS = "dsh-chat-export";
    const I18N_EMPTY_SNAPSHOT = { revision: 0 };
    const I18N_DICT = {
      en: {
        "btnExport": "Export chat",
        "btnExportTitle": "Export this conversation as Markdown, HTML, or PDF",
        "dialogTitle": "Export chat",
        "close": "Close",
        "rowConversation": "Conversation",
        "rowFormat": "Format",
        "rowContent": "Content",
        "unnamedConversation": "Untitled conversation",
        "includeReasoning": "Include thinking (off by default)",
        "includeTools": "Include tool calls & results",
        "ignoreQuestionsTitle": "Do not export user prompts; keep only assistant replies",
        "ignoreQuestions": "Ignore questioner content (replies only)",
        "selectTurns": "Select turns to export",
        "selectAll": "Select all",
        "clear": "Clear",
        "selectedCount": "Selected {n} / {total}",
        "turnOrdinal": "Turn {n}",
        "badgeReasoning": "thinking",
        "badgeTools": "tools",
        "previewUser": "User: ",
        "previewAssistant": "Assistant: ",
        "responseIncomplete": "(response incomplete)",
        "loadingTurns": "Loading turns…",
        "turnsError": "Failed to load turns: {message}",
        "retry": "Retry",
        "emptyTurns": "This conversation has no turns to export.",
        "unknownError": "unknown error",
        "cancel": "Cancel",
        "export": "Export",
        "exporting": "Exporting…",
        "generatingPdf": "Generating PDF…",
        "exported": "Exported {name}",
        "pdfFallbackNote": "Direct PDF generation did not finish; opened a print view — choose “Save as PDF”. ({reason})",
        "pdfFailHtmlNote": "PDF generation failed; downloaded HTML instead. ({reason})",
        "selectAtLeastOne": "Select at least one turn",
        "requestFailed": "Request failed: HTTP {status}{detail}",
        "pdfRenderFailed": "PDF rendering failed",
        "tooManyPages": "Conversation is too long (over {pages} pages) for direct PDF generation. Turn off “Include tool calls” or use HTML / Markdown.",
        "loadingSessions": "Loading conversations…",
        "sessionsError": "Failed to load conversations: {message}"
      },
      zh: {
        "btnExport": "导出对话",
        "btnExportTitle": "将本对话导出为 Markdown、HTML 或 PDF",
        "dialogTitle": "导出对话",
        "close": "关闭",
        "rowConversation": "对话",
        "rowFormat": "格式",
        "rowContent": "内容",
        "unnamedConversation": "未命名对话",
        "includeReasoning": "包含思考过程（默认忽略）",
        "includeTools": "包含工具调用与结果",
        "ignoreQuestionsTitle": "不导出用户提问，只保留助手回复",
        "ignoreQuestions": "忽略提问内容（只导出回复）",
        "selectTurns": "选择要导出的回合",
        "selectAll": "全选",
        "clear": "清空",
        "selectedCount": "已选 {n} / {total}",
        "turnOrdinal": "回合 {n}",
        "badgeReasoning": "思考",
        "badgeTools": "工具",
        "previewUser": "用户：",
        "previewAssistant": "助手：",
        "responseIncomplete": "（回复未完成）",
        "loadingTurns": "正在读取回合…",
        "turnsError": "回合读取失败：{message}",
        "retry": "重试",
        "emptyTurns": "该对话没有可导出的回合。",
        "unknownError": "未知错误",
        "cancel": "取消",
        "export": "导出",
        "exporting": "正在导出…",
        "generatingPdf": "正在生成 PDF…",
        "exported": "已导出 {name}",
        "pdfFallbackNote": "PDF 直接生成未成功，已打开打印视图，请在打印窗口选择“另存为 PDF”。（{reason}）",
        "pdfFailHtmlNote": "PDF 生成失败，已改为下载 HTML。（{reason}）",
        "selectAtLeastOne": "请至少选择一个回合",
        "requestFailed": "请求失败：HTTP {status}{detail}",
        "pdfRenderFailed": "PDF 渲染失败",
        "tooManyPages": "对话过长（超过 {pages} 页），直接生成 PDF 可能很慢。请关闭“包含工具调用”或改用 HTML / Markdown。",
        "loadingSessions": "正在读取对话列表…",
        "sessionsError": "对话列表读取失败：{message}"
      }
    };
    let i18nTranslate = null;
    let i18nLocale = null;
    let i18nFallbackLang = "en";
    function detectLang(tag) {
      return String(tag || "").toLowerCase().startsWith("zh") ? "zh" : "en";
    }
    function fallbackTranslate(lang) {
      const dict = I18N_DICT[lang] || I18N_DICT.en;
      return (key) => dict[key] || I18N_DICT.en[key] || key;
    }
    function t(key, vars) {
      let value = null;
      if (i18nTranslate) {
        try { value = i18nTranslate(key); } catch { value = null; }
      }
      if (typeof value !== "string" || value === key) value = fallbackTranslate(i18nFallbackLang)(key);
      if (vars) {
        for (const name of Object.keys(vars)) value = value.split("{" + name + "}").join(String(vars[name]));
      }
      return value;
    }
    function subscribeLocale(callback) {
      if (i18nLocale && typeof i18nLocale.subscribe === "function") return i18nLocale.subscribe(callback);
      return () => {};
    }
    function getLocaleRevision() {
      if (i18nLocale && typeof i18nLocale.getSnapshot === "function") return i18nLocale.getSnapshot();
      return I18N_EMPTY_SNAPSHOT;
    }
    function currentLang() {
      try {
        const snapshot = i18nLocale && typeof i18nLocale.getLocale === "function" ? i18nLocale.getLocale() : null;
        return detectLang((snapshot && snapshot.active) || i18nFallbackLang);
      } catch {
        return i18nFallbackLang;
      }
    }

    const SESSIONS_PATH = '/api/chat-export.sessions';
    const TURNS_PATH = '/api/chat-export.turns';
    const BUILD_PATH = '/api/chat-export.build';

    const STYLE_ID = 'dsh-chat-export/action';
    const STYLE = [
      '.dshChatExportControls{display:flex;align-items:center;gap:6px}',
      '.dshChatExportButton{border:1px solid var(--dsw-alias-border-l2);height:32px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);cursor:pointer;background:transparent;border-radius:18px;padding:6px 12px;font-size:13px;line-height:20px;white-space:nowrap}',
      '.dshChatExportButton:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.dshChatExportButton:disabled{color:var(--dsw-alias-label-secondary);cursor:not-allowed}',
      '.dshChatExportOverlay{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.42)}',
      '.dshChatExportDialog{box-sizing:border-box;display:flex;flex-direction:column;width:min(720px,100%);max-height:min(820px,calc(100vh - 40px));overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);box-shadow:0 18px 48px rgba(0,0,0,.28)}',
      '.dshChatExportHead{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
      '.dshChatExportHead h2{margin:0;font-size:16px;line-height:24px}',
      '.dshChatExportClose{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:20px;line-height:20px;padding:4px 8px;cursor:pointer;border-radius:8px}',
      '.dshChatExportBody{padding:14px 18px;overflow-y:auto}',
      '.dshChatExportRow{display:flex;align-items:center;gap:10px;margin:0 0 12px}',
      '.dshChatExportRowLabel{min-width:86px;color:var(--dsw-alias-label-secondary);font-size:13px}',
      '.dshChatExportSelect{min-width:0}',
      '.dshChatExportSelect select{width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.dshChatExportSeg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}',
      '.dshChatExportSeg button{border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:7px 14px;cursor:pointer}',
      '.dshChatExportSeg button.isActive{background:#2563eb;color:#ffffff;font-weight:600}',
      '.dshChatExportCheck{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.dshChatExportToolbar{display:flex;align-items:center;gap:8px;padding:6px 0 10px;border-top:1px solid var(--dsw-alias-border-l2);margin-top:4px}',
      '.dshChatExportSmall{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 9px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}',
      '.dshChatExportSmall:disabled{color:var(--dsw-alias-label-secondary);cursor:not-allowed}',
      '.dshChatExportCount{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dshChatExportTurns{list-style:none;margin:0;padding:0}',
      '.dshChatExportTurn{border-bottom:1px solid var(--dsw-alias-border-l2)}',
      '.dshChatExportTurn:last-child{border-bottom:0}',
      '.dshChatExportTurnLabel{display:grid;grid-template-columns:20px minmax(0,1fr);gap:10px;padding:10px 2px;cursor:pointer}',
      '.dshChatExportTurnLabel input{margin-top:3px}',
      '.dshChatExportOrd{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.dshChatExportPreview{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:19px}',
      '.dshChatExportPreview.asst{color:var(--dsw-alias-label-secondary)}',
      '.dshChatExportBadge{display:inline-block;margin-left:6px;font-size:11px;padding:0 6px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.dshChatExportHint{color:var(--dsw-alias-label-secondary);font-size:13px;margin:14px 0}',
      '.dshChatExportError{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:6px 0}',
      '.dshChatExportNote{color:var(--dsw-alias-label-secondary);font-size:12px;margin:6px 0}',
      '.dshChatExportFoot{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:14px 18px;border-top:1px solid var(--dsw-alias-border-l2)}',
      '.dshChatExportPrimary{border:1px solid #2563eb;border-radius:8px;padding:8px 16px;background:#2563eb;color:#ffffff;font:inherit;font-size:13px;cursor:pointer}',
      '.dshChatExportPrimary:disabled{opacity:.55;cursor:not-allowed}',
      '.dshChatExportSecondary{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 16px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}',
    ].join('');

    function ensureStyle() {
      if (typeof document === 'undefined') return () => {};
      if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return () => {};
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-chat-export';
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = STYLE;
      document.head.appendChild(tag);
      return () => tag.remove();
    }

    function errorMessage(error) {
      return error instanceof Error ? error.message : String(error);
    }

    function hostBase() {
      const origin = globalThis.location?.origin;
      return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal';
    }

    async function postJson(path, body) {
      const response = await fetch(new URL(path, hostBase()), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(t('requestFailed', { status: response.status, detail: detail === '' ? '' : ' ' + detail }));
      }
      return response.json();
    }

    function saveBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.hidden = true;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // Wrap the PDF fragment in a standalone document. The fragment is built
    // with its details expanded so the print fallback does not silently drop
    // reasoning or tool sections.
    function printDocumentFromFragment(fragment) {
      const escape = (value) => String(value).replace(/[&<>]/gu, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;',
      }[character]));
      return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escape(fragment?.title ?? '')}</title>
<style>${fragment?.style ?? ''}</style>
</head>
<body class="dsh-export">
${fragment?.bodyHtml ?? ''}
</body>
</html>`;
    }

    // Last-resort PDF path: show the exported HTML in a hidden iframe and open
    // the browser print dialog, where the user can choose "Save as PDF".
    function printHtmlDocument(html) {
      try {
        const frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;';
        frame.srcdoc = html;
        let started = false;
        frame.onload = () => {
          if (started) return;
          started = true;
          try {
            frame.contentWindow.focus();
            frame.contentWindow.print();
          } catch {
            // ignore
          }
          setTimeout(() => frame.remove(), 60000);
        };
        document.body.appendChild(frame);
        return true;
      } catch {
        return false;
      }
    }

    function compactSelection(selected, turnCount) {
      const included = Array.from(selected).sort((left, right) => left - right);
      let selection;
      if (included.length <= turnCount - included.length) {
        selection = { include: included };
      } else {
        const excluded = [];
        for (let index = 0; index < turnCount; index++) {
          if (!selected.has(index)) excluded.push(index);
        }
        selection = { exclude: excluded };
      }
      if (JSON.stringify(selection).length <= 4096) return { ...selection, count: turnCount };
      const bytes = new Uint8Array(Math.ceil(turnCount / 8));
      for (const index of selected) bytes[index >> 3] |= 1 << (index & 7);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return { bits: btoa(binary), count: turnCount };
    }

    function shortId(sessionId) {
      const value = String(sessionId);
      const match = /^session-([0-9A-Fa-f]{8})/u.exec(value);
      if (match !== null) return match[1].toLowerCase();
      return value.length > 8 ? value.slice(0, 8) : value;
    }

    // ---- PDF: rasterize exported HTML, then assemble a dependency-free PDF ----

    const A4W = 794;   // A4 at 96dpi
    const A4H = 1123;
    const SCALE = 2;
    const MAX_PDF_PAGES = 150;

    function measureExportHeight(fragment) {
      if (typeof document === 'undefined') return null;
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:-100000px;top:0;width:' + A4W + 'px;visibility:hidden;';
      const style = document.createElement('style');
      style.textContent = cssForRaster(fragment.style);
      host.appendChild(style);
      const content = document.createElement('div');
      content.className = 'dsh-export';
      content.innerHTML = xhtmlBody(fragment.bodyHtml);
      host.appendChild(content);
      document.body.appendChild(host);
      try {
        return content.getBoundingClientRect().height;
      } finally {
        host.remove();
      }
    }

    function cssForRaster(style) {
      return String(style).replace(/body\.dsh-export/gu, '.dsh-export')
        + '\n.dsh-export{width:' + A4W + 'px;background:#ffffff}'
        + '\n.dsh-md pre.dsh-code code{white-space:pre-wrap;overflow-wrap:anywhere}';
    }

    function xhtmlBody(html) {
      return String(html)
        .replace(/<br\s*\/?>/giu, '<br/>')
        .replace(/<hr\s*\/?>/giu, '<hr/>')
        .replace(/<img([^>]*?)\/?>/giu, '<img$1/>');
    }

    function svgForPage(bodyHtml, css, offset, height) {
      const inner =
        '<div xmlns="http://www.w3.org/1999/xhtml">' +
        '<style>' + css + '</style>' +
        '<div class="dsh-export" style="transform:translateY(-' + offset + 'px)">' + xhtmlBody(bodyHtml) + '</div>' +
        '</div>';
      return '<svg xmlns="http://www.w3.org/2000/svg" width="' + A4W + '" height="' + height + '">' +
        '<foreignObject x="0" y="0" width="' + A4W + '" height="' + height + '">' + inner + '</foreignObject></svg>';
    }

    function svgDataUrl(svgString) {
      const bytes = new TextEncoder().encode(svgString);
      let binary = '';
      const CHUNK = 0x8000;
      for (let index = 0; index < bytes.length; index += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + CHUNK));
      }
      return 'data:image/svg+xml;base64,' + btoa(binary);
    }

    async function rasterPage(svgString, height) {
      // A blob: URL for an SVG that contains foreignObject taints the canvas in
      // Chromium ("cross-origin data"), so toDataURL() throws. A data: URL does
      // not taint and rasterizes correctly.
      const url = svgDataUrl(svgString);
      const image = new Image();
      image.decoding = 'async';
      await new Promise((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error(t('pdfRenderFailed')));
        image.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(A4W * SCALE);
      canvas.height = Math.round(height * SCALE);
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.setTransform(SCALE, 0, 0, SCALE, 0, 0);
      context.drawImage(image, 0, 0, A4W, height);
      return canvas;
    }

    function dataUrlToBytes(dataUrl) {
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      return bytes;
    }

    function assemblePdf(jpegPages) {
      const chunks = [];
      let offset = 0;
      const encoder = new TextEncoder();
      const pushBytes = (bytes) => { chunks.push(bytes); offset += bytes.length; };
      const pushText = (text) => pushBytes(encoder.encode(text));
      const offsets = [];
      const pageWidth = 595;
      const pageHeight = 842;
      const count = jpegPages.length;
      const total = 2 + count * 3;

      const addStreamObject = (num, dict, streamBytes) => {
        offsets[num] = offset;
        pushText(num + ' 0 obj\n' + dict + '\nstream\n');
        pushBytes(streamBytes);
        pushText('\nendstream\nendobj\n');
      };
      const addObject = (num, dict) => {
        offsets[num] = offset;
        pushText(num + ' 0 obj\n' + dict + '\nendobj\n');
      };

      pushText('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n');

      addObject(1, '<< /Type /Catalog /Pages 2 0 R >>');
      const kids = [];
      for (let index = 0; index < count; index++) kids.push((3 + index * 3) + ' 0 R');
      addObject(2, '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + count + ' >>');

      for (let index = 0; index < count; index++) {
        const pageObj = 3 + index * 3;
        const contentObj = pageObj + 1;
        const imageObj = pageObj + 2;
        const jpeg = jpegPages[index];
        addObject(pageObj,
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pageWidth + ' ' + pageHeight + '] ' +
          '/Resources << /XObject << /Im0 ' + imageObj + ' 0 R >> >> /Contents ' + contentObj + ' 0 R >>');
        const drawnHeight = pageWidth * (jpeg.height / jpeg.width);
        const content = 'q ' + pageWidth + ' 0 0 ' + drawnHeight.toFixed(3) + ' 0 ' + (pageHeight - drawnHeight).toFixed(3) + ' cm /Im0 Do Q';
        addStreamObject(contentObj, '<< /Length ' + encoder.encode(content).length + ' >>', encoder.encode(content));
        addStreamObject(imageObj,
          '<< /Type /XObject /Subtype /Image /Width ' + jpeg.width + ' /Height ' + jpeg.height +
          ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.bytes.length + ' >>',
          jpeg.bytes);
      }

      const xrefStart = offset;
      pushText('xref\n0 ' + (total + 1) + '\n0000000000 65535 f \n');
      for (let num = 1; num <= total; num++) {
        pushText(String(offsets[num] ?? 0).padStart(10, '0') + ' 00000 n \n');
      }
      pushText('trailer\n<< /Size ' + (total + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF\n');

      return new Blob(chunks, { type: 'application/pdf' });
    }

    const PAGE_SLACK = 300; // extra CSS px rendered so the straddling line is fully visible

    // Analyze one full-page render: find the last content row and the lowest
    // horizontal band of blank rows inside the page window. A row counts as
    // blank when it is uniform (whitespace / solid code background) OR when it
    // has very few dark pixels (a whitespace gap crossed by a vertical card
    // border). Cutting inside such a band can never cut through glyphs.
    function analyzePage(canvas) {
      const width = canvas.width;
      const height = canvas.height;
      const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
      const step = 2;
      const pagePx = Math.round(A4H * SCALE);
      const minCutPx = Math.round(pagePx * 0.5);
      const maxCutPx = Math.min(pagePx, height - 1);
      let contentBottom = -1;
      let bestCut = -1;
      let runStart = -1;
      for (let y = 0; y < height; y++) {
        const base = y * width * 4;
        let min = 765;
        let max = 0;
        let dark = 0;
        for (let x = 0; x < width; x += step) {
          const i = base + x * 4;
          const lum = data[i] + data[i + 1] + data[i + 2];
          if (lum < min) min = lum;
          if (lum > max) max = lum;
          if (lum < 720) dark++;
        }
        const blank = (max - min <= 12) || dark === 0;
        if (!blank) contentBottom = y;
        if (y >= minCutPx && y <= maxCutPx) {
          if (blank) {
            if (runStart < 0) runStart = y;
          } else if (runStart >= 0) {
            if (y - runStart >= 6) bestCut = (runStart + y - 1) / 2;
            runStart = -1;
          }
        }
      }
      if (runStart >= 0 && maxCutPx - runStart + 1 >= 6) bestCut = (runStart + maxCutPx) / 2;
      if (contentBottom < 0) return { blank: true, contentBottomCss: 0, cutCss: null };
      return {
        blank: false,
        contentBottomCss: contentBottom / SCALE,
        cutCss: bestCut > 0 ? bestCut / SCALE : null,
      };
    }

    async function buildPdfBlob(fragment) {
      const estimatedHeight = measureExportHeight(fragment);
      if (estimatedHeight !== null && estimatedHeight > A4H * (MAX_PDF_PAGES + 2)) {
        throw new Error(t('tooManyPages', { pages: MAX_PDF_PAGES }));
      }
      const css = cssForRaster(fragment.style);
      const bodyHtml = fragment.bodyHtml;
      const renderHeight = A4H + PAGE_SLACK;
      const jpegPages = [];
      let start = 0;
      const pushCanvas = (canvas) => {
        jpegPages.push({
          bytes: dataUrlToBytes(canvas.toDataURL('image/jpeg', 0.92)),
          width: canvas.width,
          height: canvas.height,
        });
      };
      for (let guard = 0; guard < 300; guard++) {
        const canvas = await rasterPage(svgForPage(bodyHtml, css, start, renderHeight), renderHeight);
        const info = analyzePage(canvas);
        if (info.blank) break;
        let cutCss;
        if (info.contentBottomCss <= A4H - 0.5) {
          cutCss = Math.min(A4H, info.contentBottomCss + 6);
        } else if (info.cutCss !== null) {
          cutCss = Math.min(A4H, info.cutCss);
        } else {
          cutCss = A4H; // extremely dense block without a gap; last resort
        }
        if (cutCss < 8) cutCss = Math.min(A4H, info.contentBottomCss + 6);
        const cutPx = Math.max(1, Math.min(canvas.height, Math.round(cutCss * SCALE)));
        const page = document.createElement('canvas');
        page.width = canvas.width;
        page.height = cutPx;
        page.getContext('2d').drawImage(canvas, 0, 0, canvas.width, cutPx, 0, 0, canvas.width, cutPx);
        if (jpegPages.length >= MAX_PDF_PAGES) {
          throw new Error(t('tooManyPages', { pages: MAX_PDF_PAGES }));
        }
        pushCanvas(page);
        start += cutCss;
        if (cutCss <= 1) break;
      }
      if (jpegPages.length === 0) {
        const blank = document.createElement('canvas');
        blank.width = Math.round(A4W * SCALE);
        blank.height = Math.round(A4H * SCALE);
        const context = blank.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, blank.width, blank.height);
        pushCanvas(blank);
      }
      return assemblePdf(jpegPages);
    }

    // ---- React component ----

    function ChatExportAction({ sessionId }) {
      useLocaleStore(subscribeLocale, getLocaleRevision);
      const [open, setOpen] = useState(false);
      const [sessions, setSessions] = useState({ status: 'idle', list: [], error: null, loadedAt: 0 });
      const [target, setTarget] = useState(sessionId);
      const [turns, setTurns] = useState({ status: 'idle', list: [], error: null });
      const [selected, setSelected] = useState(() => new Set());
      const [format, setFormat] = useState('md');
      const [includeReasoning, setIncludeReasoning] = useState(false);
      const [includeTools, setIncludeTools] = useState(false);
      const [ignoreQuestions, setIgnoreQuestions] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [note, setNote] = useState(null);
      const dialogRef = useRef(null);
      const sessionsRequest = useRef(0);
      const turnsRequest = useRef(0);
      const busyRef = useRef(false);
      busyRef.current = busy;

      useEffect(() => {
        if (!open) return undefined;
        const previous = document.activeElement;
        const dialog = dialogRef.current;
        const focusables = () => Array.from(dialog?.querySelectorAll(
          'button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? []);
        const first = focusables()[0];
        if (first !== undefined) first.focus();
        else dialog?.focus();
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            if (busyRef.current) return;
            event.preventDefault();
            setOpen(false);
            return;
          }
          if (event.key !== 'Tab') return;
          const items = focusables();
          if (items.length === 0) {
            event.preventDefault();
            return;
          }
          const firstItem = items[0];
          const lastItem = items[items.length - 1];
          if (event.shiftKey && document.activeElement === firstItem) {
            event.preventDefault();
            lastItem.focus();
          } else if (!event.shiftKey && document.activeElement === lastItem) {
            event.preventDefault();
            firstItem.focus();
          }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('keydown', onKeyDown);
          if (previous instanceof HTMLElement) previous.focus();
        };
      }, [open]);

      async function loadSessions() {
        const request = ++sessionsRequest.current;
        setSessions((current) => ({ ...current, status: 'loading', error: null }));
        try {
          const value = await postJson(SESSIONS_PATH, {});
          if (request !== sessionsRequest.current) return;
          setSessions({
            status: 'ready',
            list: Array.isArray(value.sessions) ? value.sessions : [],
            error: null,
            loadedAt: Date.now(),
          });
        } catch (caught) {
          if (request !== sessionsRequest.current) return;
          setSessions((current) => ({ ...current, status: 'error', error: errorMessage(caught) }));
        }
      }

      async function loadTurns(id) {
        const request = ++turnsRequest.current;
        setTurns({ status: 'loading', list: [], error: null });
        setSelected(new Set());
        try {
          const value = await postJson(TURNS_PATH, { sessionId: id });
          if (request !== turnsRequest.current) return;
          const list = Array.isArray(value.turns) ? value.turns : [];
          setTurns({ status: 'ready', list, error: null });
          setSelected(new Set(list.map((turn) => turn.index)));
        } catch (caught) {
          if (request !== turnsRequest.current) return;
          setTurns({ status: 'error', list: [], error: errorMessage(caught) });
        }
      }

      function openDialog() {
        setOpen(true);
        setError(null);
        setNote(null);
        setTarget(sessionId);
        if (sessions.status !== 'ready' || Date.now() - sessions.loadedAt > 30000) loadSessions();
        loadTurns(sessionId);
      }

      function closeDialog() {
        if (busy) return;
        setOpen(false);
      }

      async function doExport() {
        setError(null);
        setNote(null);
        if (selected.size === 0) {
          setError(t('selectAtLeastOne'));
          return;
        }
        setBusy(true);
        try {
          const value = await postJson(BUILD_PATH, {
            sessionId: target,
            format,
            lang: currentLang(),
            includeReasoning,
            includeTools,
            ignoreQuestions,
            selection: compactSelection(selected, turns.list.length),
          });
          const stem = value.fileStem || 'dsh-conversation';
          if (format === 'md') {
            saveBlob(new Blob([value.markdown], { type: 'text/markdown;charset=utf-8' }), stem + '.md');
            setNote(t('exported', { name: stem + '.md' }));
          } else if (format === 'html') {
            saveBlob(new Blob([value.html], { type: 'text/html;charset=utf-8' }), stem + '.html');
            setNote(t('exported', { name: stem + '.html' }));
          } else {
            setNote(t('generatingPdf'));
            try {
              const blob = await buildPdfBlob(value.fragment);
              saveBlob(blob, stem + '.pdf');
              setNote(t('exported', { name: stem + '.pdf' }));
            } catch (pdfError) {
              const reason = errorMessage(pdfError);
              const printHtml = value.fragment === undefined ? value.html : printDocumentFromFragment(value.fragment);
              if (printHtmlDocument(printHtml)) {
                setNote(t('pdfFallbackNote', { reason }));
              } else {
                saveBlob(new Blob([value.html], { type: 'text/html;charset=utf-8' }), stem + '.html');
                setNote(t('pdfFailHtmlNote', { reason }));
              }
            }
          }
        } catch (caught) {
          setError(errorMessage(caught));
          setNote(null);
        } finally {
          setBusy(false);
        }
      }

      const targetTurns = turns.status === 'ready' ? turns.list : [];
      const selectedCount = selected.size;

      if (!open) {
        return jsx('div', {
          className: 'dshChatExportControls',
          children: jsx('button', {
            type: 'button',
            className: 'dshChatExportButton',
            title: t('btnExportTitle'),
            onClick: openDialog,
            children: t('btnExport'),
          }),
        });
      }

      const sessionOptions = (() => {
        const list = sessions.list.slice();
        if (!list.some((item) => item.sessionId === sessionId)) {
          list.unshift({ sessionId, title: null });
        }
        return list;
      })();

      let turnBody;
      if (turns.status === 'loading') {
        turnBody = jsx('p', { className: 'dshChatExportHint', children: t('loadingTurns') });
      } else if (turns.status === 'error') {
        turnBody = jsxs('div', {
          children: [
            jsx('p', { className: 'dshChatExportHint', children: t('turnsError', { message: turns.error || t('unknownError') }) }),
            jsx('button', { type: 'button', className: 'dshChatExportSmall', onClick: () => loadTurns(target), children: t('retry') }),
          ],
        });
      } else if (turns.list.length === 0) {
        turnBody = jsx('p', { className: 'dshChatExportHint', children: t('emptyTurns') });
      } else {
        turnBody = jsx('ul', {
          className: 'dshChatExportTurns',
          children: turns.list.map((turn) => jsx('li', {
            className: 'dshChatExportTurn',
            children: jsxs('label', {
              className: 'dshChatExportTurnLabel',
              children: [
                jsx('input', {
                  type: 'checkbox',
                  checked: selected.has(turn.index),
                  disabled: busy,
                  onChange: (event) => setSelected((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(turn.index);
                    else next.delete(turn.index);
                    return next;
                  }),
                }),
                jsxs('span', {
                  children: [
                    jsxs('span', {
                      className: 'dshChatExportOrd',
                      children: [
                        t('turnOrdinal', { n: turn.index + 1 }),
                        turn.hasReasoning ? jsx('span', { className: 'dshChatExportBadge', children: t('badgeReasoning') }) : null,
                        turn.hasTools ? jsx('span', { className: 'dshChatExportBadge', children: t('badgeTools') }) : null,
                      ],
                    }),
                    jsx('div', { className: 'dshChatExportPreview', children: t('previewUser') + turn.human }),
                    jsx('div', {
                      className: 'dshChatExportPreview asst',
                      children: turn.assistant === null ? t('responseIncomplete') : t('previewAssistant') + turn.assistant,
                    }),
                  ],
                }),
              ],
            }),
          }, turn.index)),
        });
      }

      const canExport = !busy && turns.status === 'ready' && selectedCount > 0;

      return jsxs('div', {
        className: 'dshChatExportControls',
        children: [
          jsx('button', {
            type: 'button',
            className: 'dshChatExportButton',
            title: t('btnExportTitle'),
            onClick: openDialog,
            children: t('btnExport'),
          }),
          ReactDOM.createPortal(jsxs('div', {
            className: 'dshChatExportOverlay',
            onMouseDown: (event) => { if (event.target === event.currentTarget) closeDialog(); },
            children: [
              jsxs('div', {
                ref: dialogRef,
                className: 'dshChatExportDialog',
                role: 'dialog',
                'aria-modal': true,
                'aria-label': t('btnExport'),
                tabIndex: -1,
                children: [
                  jsxs('div', {
                    className: 'dshChatExportHead',
                    children: [
                      jsx('h2', { children: t('dialogTitle') }),
                      jsx('button', {
                        type: 'button',
                        className: 'dshChatExportClose',
                        'aria-label': t('close'),
                        disabled: busy,
                        onClick: closeDialog,
                        children: '×',
                      }),
                    ],
                  }),
                  jsxs('div', {
                    className: 'dshChatExportBody',
                    children: [
                      jsxs('div', {
                        className: 'dshChatExportRow',
                        children: [
                          jsx('span', { className: 'dshChatExportRowLabel', children: t('rowConversation') }),
                          jsx('div', {
                            className: 'dshChatExportSelect',
                            style: { flex: '1 1 auto' },
                            children: jsx('select', {
                              value: target,
                              disabled: busy,
                              onChange: (event) => {
                                const id = event.target.value;
                                setTarget(id);
                                loadTurns(id);
                              },
                              children: sessionOptions.map((item) => jsx('option', {
                                value: item.sessionId,
                                children: (item.title || t('unnamedConversation')) + ' · ' + shortId(item.sessionId),
                              }, item.sessionId)),
                            }),
                          }),
                        ],
                      }),
                      sessions.status === 'loading'
                        ? jsx('p', { className: 'dshChatExportHint', children: t('loadingSessions') })
                        : null,
                      sessions.status === 'error'
                        ? jsxs('div', {
                          className: 'dshChatExportHint',
                          children: [
                            jsx('span', { className: 'dshChatExportError', children: t('sessionsError', { message: sessions.error || t('unknownError') }) }),
                            jsx('button', { type: 'button', className: 'dshChatExportSmall', onClick: loadSessions, children: t('retry') }),
                          ],
                        })
                        : null,
                      jsxs('div', {
                        className: 'dshChatExportRow',
                        children: [
                          jsx('span', { className: 'dshChatExportRowLabel', children: t('rowFormat') }),
                          jsx('div', {
                            className: 'dshChatExportSeg',
                            children: [
                              jsx('button', { type: 'button', className: format === 'md' ? 'isActive' : '', disabled: busy, onClick: () => setFormat('md'), children: 'Markdown' }),
                              jsx('button', { type: 'button', className: format === 'html' ? 'isActive' : '', disabled: busy, onClick: () => setFormat('html'), children: 'HTML' }),
                              jsx('button', { type: 'button', className: format === 'pdf' ? 'isActive' : '', disabled: busy, onClick: () => setFormat('pdf'), children: 'PDF' }),
                            ],
                          }),
                        ],
                      }),
                      jsxs('div', {
                        className: 'dshChatExportRow',
                        children: [
                          jsx('span', { className: 'dshChatExportRowLabel', children: t('rowContent') }),
                          jsxs('div', {
                            style: { display: 'flex', gap: '16px', flexWrap: 'wrap' },
                            children: [
                              jsxs('label', {
                                className: 'dshChatExportCheck',
                                children: [
                                  jsx('input', { type: 'checkbox', checked: includeReasoning, disabled: busy, onChange: (event) => setIncludeReasoning(event.target.checked) }),
                                  t('includeReasoning'),
                                ],
                              }),
                              jsxs('label', {
                                className: 'dshChatExportCheck',
                                children: [
                                  jsx('input', { type: 'checkbox', checked: includeTools, disabled: busy, onChange: (event) => setIncludeTools(event.target.checked) }),
                                  t('includeTools'),
                                ],
                              }),
                              jsxs('label', {
                                className: 'dshChatExportCheck',
                                title: t('ignoreQuestionsTitle'),
                                children: [
                                  jsx('input', { type: 'checkbox', checked: ignoreQuestions, disabled: busy, onChange: (event) => setIgnoreQuestions(event.target.checked) }),
                                  t('ignoreQuestions'),
                                ],
                              }),
                            ],
                          }),
                        ],
                      }),
                      jsxs('div', {
                        className: 'dshChatExportToolbar',
                        children: [
                          jsx('span', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' }, children: t('selectTurns') }),
                          jsx('button', {
                            type: 'button',
                            className: 'dshChatExportSmall',
                            disabled: busy || targetTurns.length === 0 || selectedCount === targetTurns.length,
                            onClick: () => setSelected(new Set(targetTurns.map((turn) => turn.index))),
                            children: t('selectAll'),
                          }),
                          jsx('button', {
                            type: 'button',
                            className: 'dshChatExportSmall',
                            disabled: busy || selectedCount === 0,
                            onClick: () => setSelected(new Set()),
                            children: t('clear'),
                          }),
                          jsx('span', { className: 'dshChatExportCount', children: t('selectedCount', { n: selectedCount, total: targetTurns.length }) }),
                        ],
                      }),
                      turnBody,
                      error !== null ? jsx('p', { className: 'dshChatExportError', role: 'alert', children: error }) : null,
                      note !== null ? jsx('p', { className: 'dshChatExportNote', children: note }) : null,
                    ],
                  }),
                  jsxs('div', {
                    className: 'dshChatExportFoot',
                    children: [
                      jsx('button', { type: 'button', className: 'dshChatExportSecondary', disabled: busy, onClick: closeDialog, children: t('cancel') }),
                      jsx('button', {
                        type: 'button',
                        className: 'dshChatExportPrimary',
                        disabled: !canExport,
                        'aria-busy': busy,
                        onClick: doExport,
                        children: busy ? (format === 'pdf' ? t('generatingPdf') : t('exporting')) : t('export'),
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }), document.body),
        ],
      });
    }

    return {
      inject: ['slots', 'locale'],
      __test: { assemblePdf, compactSelection, cssForRaster, printDocumentFromFragment, shortId, xhtmlBody, analyzePage, i18nDict: I18N_DICT, translate: t, currentLang },
      apply(ctx) {
        if (typeof ctx.effect === 'function') ctx.effect(ensureStyle, 'chat-export: styles');
        else ensureStyle();
        try {
          const locale = ctx.get?.('locale');
          const activeSnapshot = locale && typeof locale.getLocale === 'function' ? locale.getLocale() : null;
          const active = (activeSnapshot && activeSnapshot.active) || (typeof navigator !== 'undefined' ? navigator.language : 'en');
          i18nFallbackLang = detectLang(active);
          if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
            for (const code of ['en', 'zh']) {
              const registerLocale = () => locale.register(I18N_NS, code, I18N_DICT[code]);
              if (typeof ctx.effect === 'function') ctx.effect(registerLocale, 'chat-export: locale ' + code);
              else registerLocale();
            }
            i18nTranslate = locale.bind(I18N_NS);
            i18nLocale = locale;
          } else {
            i18nTranslate = fallbackTranslate(i18nFallbackLang);
          }
        } catch {
          i18nTranslate = fallbackTranslate(i18nFallbackLang);
        }
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'chat-export',
          order: 20,
          label: () => t('btnExport'),
        }, ChatExportAction));
      },
    };
  },
});
