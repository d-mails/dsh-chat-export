/**
 * Render extracted conversation entries as Markdown or HTML.
 *
 * Message text is Markdown and preserved verbatim (Markdown output) or
 * converted to sanitized HTML (HTML output). A still-open fenced code block at
 * the end of one message is closed so it cannot swallow later sections.
 */

import { markdownToHtml } from './md-html.js';

const LABELS = {
  en: {
    fallbackTitle: 'DSH Conversation',
    human: 'Human',
    assistant: 'Assistant',
    thinking: 'Thinking',
    toolCall: 'Tool call',
    arguments: 'Arguments',
    result: 'Result',
    resultError: 'Result (error)',
    resultNotCaptured: 'Result: (not captured)',
    incompleteMarkdown: '> Response incomplete.',
    incompleteHtml: 'Response incomplete.',
    empty: 'No conversation content to export.',
    unparsed: '> _[Interactive component: content could not be parsed]_',
    interactiveTitle: (title) => `> _[Interactive component${title ? ': ' + title : ''}]_`,
    keyValue: (key, value) => `- **${key}**: ${value}`,
    stat: (label, value) => `- **${label}**: ${value}`,
    chartLabel: 'Label',
    chartValue: 'Value',
    htmlLang: 'en',
  },
  zh: {
    fallbackTitle: '\u0044\u0053\u0048 \u5bf9\u8bdd',
    human: '用户',
    assistant: '助手',
    thinking: '思考过程',
    toolCall: '工具调用',
    arguments: '参数',
    result: '结果',
    resultError: '结果（错误）',
    resultNotCaptured: '结果：（未捕获）',
    incompleteMarkdown: '> 回复未完成。',
    incompleteHtml: '回复未完成。',
    empty: '没有可导出的对话内容。',
    unparsed: '> _[交互组件：内容无法解析]_',
    interactiveTitle: (title) => `> _[交互组件${title ? '：' + title : ''}]_`,
    keyValue: (key, value) => `- **${key}**：${value}`,
    stat: (label, value) => `- **${label}**：${value}`,
    chartLabel: '\u6807\u7b7e',
    chartValue: '\u6570\u503c',
    htmlLang: 'zh-CN',
  },
};
function labelsFor(lang) {
  return LABELS[lang === 'zh' ? 'zh' : 'en'];
}

function openingFence(line) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  if (match === null) return null;
  const run = match[1];
  if (run[0] === '`' && match[2].includes('`')) return null;
  return { character: run[0], length: run.length };
}

function closesFence(line, open) {
  const match = /^ {0,3}(`+|~+)[ \t]*$/u.exec(line);
  return match !== null && match[1][0] === open.character && match[1].length >= open.length;
}

export function protectMarkdownFences(message) {
  let open = null;
  for (const line of message.split(/\r?\n/u)) {
    if (open === null) open = openingFence(line);
    else if (closesFence(line, open)) open = null;
  }
  if (open === null) return message;
  const newline = message.endsWith('\n') ? '' : '\n';
  return `${message}${newline}${open.character.repeat(open.length)}`;
}

function fenceFor(text, language = '') {
  let longest = 0;
  for (const match of String(text).matchAll(/`+/gu)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

function escapeWrapperTags(markdown) {
  let open = null;
  return String(markdown).split(/\r?\n/u).map((line) => {
    if (open !== null) {
      if (closesFence(line, open)) open = null;
      return line;
    }
    const fence = openingFence(line);
    if (fence !== null) {
      open = fence;
      return line;
    }
    return line.replace(/<(?=\/?(?:details|summary)(?=[\s/>]))/giu, '&lt;');
  }).join('\n');
}

function roleSection(roleLabel, message, lang) {
  return `> **${roleLabel}**\n\n${protectMarkdownFences(expandUiFences(message, lang))}`;
}

function mdCell(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\|/gu, '\\|')
    .replace(/\r?\n/gu, ' ');
}

function uiTable(columns, rows) {
  const head = `| ${columns.map(mdCell).join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((_column, index) => mdCell(Array.isArray(row) ? row[index] : '')).join(' | ')} |`).join('\n');
  return body === '' ? `${head}\n${sep}` : `${head}\n${sep}\n${body}`;
}

function uiSpecToMarkdown(spec, lang) {
  if (spec === null || typeof spec !== 'object') return '';
  const L = labelsFor(lang);
  const out = [];
  if (typeof spec.title === 'string' && spec.title.trim() !== '') out.push(`**${spec.title.trim()}**`);
  const walk = (items) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (item === null || typeof item !== 'object') continue;
      switch (item.type) {
        case 'table':
          if (Array.isArray(item.columns) && Array.isArray(item.rows)) out.push(uiTable(item.columns, item.rows));
          break;
        case 'chart':
          if (Array.isArray(item.data)) {
            out.push(uiTable(
              [L.chartLabel, L.chartValue],
              item.data.map((point) => [
                point?.label ?? point?.name ?? '',
                point?.value ?? '',
              ]),
            ));
          }
          break;
        case 'keyvalue':
          if (Array.isArray(item.pairs)) out.push(item.pairs.map((pair) => L.keyValue(mdCell(pair?.key), mdCell(pair?.value))).join('\n'));
          break;
        case 'list':
          if (Array.isArray(item.items)) out.push(item.items.map((entry) => `- ${mdCell(typeof entry === 'string' ? entry : (entry?.content ?? entry?.label ?? entry?.title ?? ''))}`).join('\n'));
          break;
        case 'steps':
          if (Array.isArray(item.steps)) out.push(item.steps.map((step, index) => `${index + 1}. ${mdCell(step?.title ?? step?.content ?? '')}`).join('\n'));
          break;
        case 'callout':
          if (typeof item.content === 'string' && item.content.trim() !== '') out.push(`> ${item.content.replace(/\r?\n/gu, '\n> ')}`);
          break;
        case 'text':
          if (typeof item.content === 'string' && item.content.trim() !== '') out.push(item.content);
          break;
        case 'divider':
          out.push(typeof item.label === 'string' && item.label.trim() !== '' ? `*${item.label.trim()}*` : '---');
          break;
        case 'stat':
          if (item.label !== undefined) out.push(L.stat(mdCell(item.label), mdCell(item.value)));
          break;
        default:
          if (typeof item.content === 'string' && item.content.trim() !== '') out.push(item.content);
          break;
      }
      if (Array.isArray(item.children)) walk(item.children);
    }
  };
  walk(spec.items);
  return out.join('\n\n');
}

/** Replace GenUI ```dsh-ui fences (rendered as tables/cards in the app) with readable Markdown. */
export function expandUiFences(text, lang = 'en') {
  if (typeof text !== 'string' || !text.includes('```dsh-ui')) return text;
  const L = labelsFor(lang);
  const lines = text.split(/\r?\n/u);
  const out = [];
  let outer = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (outer !== null) {
      out.push(line);
      if (closesFence(line, outer)) outer = null;
      continue;
    }
    const dshFence = /^ {0,3}(`{3,}|~{3,})dsh-ui\b/u.exec(line);
    if (dshFence !== null) {
      const fence = { character: dshFence[1][0], length: dshFence[1].length };
      const body = [];
      let cursor = index + 1;
      while (cursor < lines.length && !closesFence(lines[cursor], fence)) {
        body.push(lines[cursor]);
        cursor++;
      }
      if (cursor < lines.length) {
        let spec;
        try {
          spec = JSON.parse(body.join('\n').trim());
        } catch {
          out.push(L.unparsed);
          index = cursor;
          continue;
        }
        const markdown = uiSpecToMarkdown(spec, lang);
        if (markdown.trim() !== '') out.push(markdown);
        else {
          const title = spec && typeof spec.title === 'string' ? spec.title.trim() : '';
          out.push(L.interactiveTitle(title));
        }
        index = cursor;
        continue;
      }
      // No closing fence: leave the source untouched.
      out.push(line);
      continue;
    }
    const fence = openingFence(line);
    if (fence !== null) {
      outer = fence;
      out.push(line);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

function detailsSection(summary, body) {
  return `<details>\n<summary>${summary}</summary>\n\n${protectMarkdownFences(escapeWrapperTags(body))}\n\n</details>`;
}

function toolSection(tool, lang) {
  const L = labelsFor(lang);
  const parts = [`\`${tool.name}\``];
  if (tool.arguments && tool.arguments.trim() !== '') {
    parts.push(`${L.arguments}:\n\n${fenceFor(tool.arguments, 'json')}`);
  }
  if (tool.result && tool.result.trim() !== '') {
    parts.push(`${tool.isError ? L.resultError : L.result}:\n\n${fenceFor(tool.result, 'text')}`);
  } else if (tool.result === null) {
    parts.push(L.resultNotCaptured);
  }
  return detailsSection(`${L.toolCall} · ${escapeInline(tool.name)}`, parts.join('\n\n'));
}

function escapeInline(value) {
  return String(value).replace(/[<>&]/gu, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[character]));
}

/**
 * @param {object[]} entries
 * @param {string|null} title
 * @returns {string}
 */
export function renderMarkdown(entries, title = null, options = {}) {
  const L = labelsFor(options.lang);
  const sections = [];
  for (const entry of entries) {
    const hasTools = (entry.tools ?? []).length > 0;
    if ((entry.humans?.length ?? 0) === 0 && entry.assistant === null && !entry.reasoning && !hasTools) continue;
    for (const human of entry.humans ?? []) sections.push(roleSection(L.human, human, options.lang));
    if (entry.reasoning) sections.push(detailsSection(L.thinking, entry.reasoning));
    for (const tool of entry.tools ?? []) sections.push(toolSection(tool, options.lang));
    if (entry.assistant !== null) sections.push(roleSection(L.assistant, entry.assistant, options.lang));
    else sections.push(L.incompleteMarkdown);
  }
  const documentTitle = title ?? L.fallbackTitle;
  return sections.length > 0
    ? `# ${documentTitle}\n\n---\n\n${sections.join('\n\n---\n\n')}\n`
    : `# ${documentTitle}\n\n${L.empty}\n`;
}

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body.dsh-export {
  margin: 0; padding: 32px 20px; background: #f6f7f9; color: #1b1f24;
  font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif;
  font-size: 15px; line-height: 1.7;
}
.dsh-export-doc { max-width: 820px; margin: 0 auto; }
.dsh-export-title { font-size: 26px; line-height: 1.3; margin: 0 0 8px; }
.dsh-export-meta { color: #6b7280; font-size: 12px; margin: 0 0 24px; }
.dsh-msg { background: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px 18px; margin: 0 0 16px; }
.dsh-msg-human { border-left: 3px solid #3b82f6; }
.dsh-msg-assistant { border-left: 3px solid #10b981; }
.dsh-role { font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #6b7280; margin-bottom: 8px; }
.dsh-msg-human .dsh-role { color: #2563eb; }
.dsh-msg-assistant .dsh-role { color: #059669; }
.dsh-empty { color: #9ca3af; font-style: italic; }
.dsh-md > :first-child { margin-top: 0; }
.dsh-md > :last-child { margin-bottom: 0; }
.dsh-md p { margin: 0 0 10px; }
.dsh-md h1, .dsh-md h2, .dsh-md h3, .dsh-md h4 { margin: 18px 0 8px; line-height: 1.3; }
.dsh-md ul, .dsh-md ol { margin: 0 0 10px; padding-left: 24px; }
.dsh-md li { margin: 3px 0; }
.dsh-md blockquote { margin: 0 0 10px; padding: 6px 14px; border-left: 3px solid #d1d5db; color: #4b5563; background: #f9fafb; border-radius: 0 6px 6px 0; }
.dsh-md a { color: #2563eb; }
.dsh-md code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: .9em; background: #f1f3f5; padding: 2px 5px; border-radius: 4px; }
.dsh-md pre.dsh-code { background: #0f172a; color: #e2e8f0; padding: 12px 14px; border-radius: 8px; overflow-x: auto; margin: 0 0 10px; }
.dsh-md pre.dsh-code code { background: transparent; color: inherit; padding: 0; font-size: 13px; white-space: pre; }
.dsh-md table.dsh-table { border-collapse: collapse; width: 100%; margin: 0 0 12px; font-size: 14px; }
.dsh-md table.dsh-table th, .dsh-md table.dsh-table td { border: 1px solid #e5e7eb; padding: 6px 10px; }
.dsh-md table.dsh-table th { background: #f3f4f6; }
.dsh-md hr { border: 0; border-top: 1px solid #e5e7eb; margin: 14px 0; }
.dsh-md img, .dsh-img-note { max-width: 100%; }
.dsh-img-note { color: #9ca3af; font-size: 13px; }
details.dsh-details { background: #fbfbfd; border: 1px dashed #d1d5db; border-radius: 10px; padding: 8px 14px; margin: 0 0 14px; }
details.dsh-details > summary { cursor: pointer; color: #6b7280; font-size: 13px; font-weight: 600; }
details.dsh-details[open] > summary { margin-bottom: 8px; }
.dsh-incomplete { color: #b45309; font-style: italic; margin: 0 0 16px; }
@media print {
  body.dsh-export { background: #ffffff; padding: 0; }
  .dsh-msg, details.dsh-details { break-inside: avoid; }
  details.dsh-details { display: block; }
}
`.trim();

function htmlParts(entries, title, options = {}) {
  const L = labelsFor(options.lang);
  const body = [];
  const detailsOpen = options.detailsOpen === true ? ' open' : '';
  const documentTitle = title ?? L.fallbackTitle;
  for (const entry of entries) {
    const hasTools = (entry.tools ?? []).length > 0;
    if ((entry.humans?.length ?? 0) === 0 && entry.assistant === null && !entry.reasoning && !hasTools) continue;
    for (const human of entry.humans ?? []) {
      body.push(`<article class="dsh-msg dsh-msg-human"><div class="dsh-role">${L.human}</div><div class="dsh-md">${markdownToHtml(expandUiFences(human, options.lang), options.lang)}</div></article>`);
    }
    if (entry.reasoning) {
      body.push(`<details class="dsh-details"${detailsOpen}><summary>${L.thinking}</summary><div class="dsh-md">${markdownToHtml(entry.reasoning, options.lang)}</div></details>`);
    }
    for (const tool of entry.tools ?? []) {
      const argHtml = tool.arguments && tool.arguments.trim() !== ''
        ? `<p><strong>${L.arguments}</strong></p><pre class="dsh-code"><code class="language-json">${escapeInline(tool.arguments)}</code></pre>`
        : '';
      const resultHtml = tool.result && tool.result.trim() !== ''
        ? `<p><strong>${tool.isError ? L.resultError : L.result}</strong></p><pre class="dsh-code"><code>${escapeInline(tool.result)}</code></pre>`
        : '';
      body.push(`<details class="dsh-details"${detailsOpen}><summary>${L.toolCall} · ${escapeInline(tool.name)}</summary>${argHtml}${resultHtml}</details>`);
    }
    if (entry.assistant !== null) {
      body.push(`<article class="dsh-msg dsh-msg-assistant"><div class="dsh-role">${L.assistant}</div><div class="dsh-md">${markdownToHtml(expandUiFences(entry.assistant, options.lang), options.lang)}</div></article>`);
    } else {
      body.push(`<p class="dsh-incomplete">${L.incompleteHtml}</p>`);
    }
  }
  return {
    documentTitle,
    innerHtml: `<div class="dsh-export-doc"><h1 class="dsh-export-title">${escapeInline(documentTitle)}</h1>${body.join('\n')}</div>`,
    emptyHtml: `<div class="dsh-export-doc"><h1 class="dsh-export-title">${escapeInline(documentTitle)}</h1><p class="dsh-empty">${L.empty}</p></div>`,
    hasContent: body.length > 0,
  };
}

/** Inner document markup only, for the client-side PDF rasterizer. */
export function renderHtmlFragment(entries, title, options = {}) {
  const parts = htmlParts(entries, title, { ...options, detailsOpen: true });
  return {
    title: parts.documentTitle,
    bodyHtml: parts.hasContent ? parts.innerHtml : parts.emptyHtml,
    style: STYLE,
  };
}

/** Complete standalone HTML document for a downloaded file. */
export function renderHtmlDocument(entries, title, options = {}) {
  const L = labelsFor(options.lang);
  const parts = htmlParts(entries, title, options);
  const inner = parts.hasContent ? parts.innerHtml : parts.emptyHtml;
  return `<!DOCTYPE html>
<html lang="${L.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeInline(parts.documentTitle)}</title>
<style>
${STYLE}
</style>
</head>
<body class="dsh-export">
${inner}
</body>
</html>
`;
}

export { STYLE as HTML_STYLE };
