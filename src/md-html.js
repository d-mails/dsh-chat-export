/**
 * A small, dependency-free Markdown to HTML converter tuned for chat
 * transcripts. It supports headings, fenced code, blockquotes, ordered and
 * unordered lists, tables, horizontal rules, paragraphs, inline code, bold,
 * italic, strikethrough, links and image alt text. Raw HTML in the source is
 * escaped, never trusted.
 */

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
}

function safeUrl(url) {
  const trimmed = String(url).trim();
  if (trimmed === '') return null;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) {
    return /^(?:https?:|mailto:)/iu.test(trimmed) ? trimmed : null;
  }
  return trimmed; // relative link or fragment
}

const PLACEHOLDER = '\u0000';

function inline(raw, lang = 'en') {
  if (raw === '') return '';
  const stored = [];
  const stash = (html) => {
    const index = stored.length;
    stored.push(html);
    return `${PLACEHOLDER}${index}${PLACEHOLDER}`;
  };

  let text = String(raw);

  // Code spans first.
  text = text.replace(/`([^`\n]+)`/gu, (_match, code) => stash(`<code>${escapeHtml(code)}</code>`));

  // Images: keep the alt text, never embed remote sources.
  text = text.replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))*)(?:\s+"[^"]*")?\)/gu, (_match, alt) =>
    stash(`<span class="dsh-img-note">${lang === 'zh' ? `[图片${alt ? `：${escapeHtml(alt)}` : ''}]` : `[Image${alt ? `: ${escapeHtml(alt)}` : ''}]`}</span>`));

  // Links. One level of balanced parentheses is allowed in the destination.
  text = text.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))*)(?:\s+"[^"]*")?\)/gu, (match, label, url) => {
    const href = safeUrl(url);
    if (href === null) return stash(escapeHtml(label));
    return stash(`<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${inline(label, lang)}</a>`);
  });

  // Bare autolinks. Stash them before general text escaping so the URL is
  // escaped once as an attribute; putting it in href after escaping would let
  // a quote in the URL inject extra attributes.
  text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/gu, (match, prefix, url) => {
    const href = safeUrl(url);
    if (href === null) return match;
    return `${prefix}${stash(`<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`)}`;
  });

  text = escapeHtml(text);

  // Emphasis (markers survive HTML escaping).
  text = text.replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>');
  text = text.replace(/__([^_]+)__/gu, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/gu, '$1<em>$2</em>');
  text = text.replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/gu, '$1<em>$2</em>');
  text = text.replace(/~~([^~]+)~~/gu, '<del>$1</del>');

  text = text.replace(/\n/gu, '<br>');

  // Restore placeholders, allowing nesting of inline emphasis inside labels.
  let guard = 0;
  while (text.includes(PLACEHOLDER) && guard < 12) {
    const before = text;
    text = text.replace(new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'gu'), (_m, index) => stored[Number(index)] ?? '');
    if (before === text) break;
    guard++;
  }
  return text;
}

function isFence(line) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  if (match === null) return null;
  if (match[1][0] === '`' && match[2].includes('`')) return null;
  return { character: match[1][0], length: match[1].length, info: match[2].trim() };
}

function isClosingFence(line, fence) {
  const match = /^ {0,3}(`+|~+)\s*$/u.exec(line);
  return match !== null && match[1][0] === fence.character && match[1].length >= fence.length;
}

function splitRow(line) {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  const cells = [];
  let cell = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === '\\' && value[index + 1] === '|') {
      cell += '|';
      index++;
      continue;
    }
    if (character === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

function isTableSeparator(line) {
  if (!line.includes('-')) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/u.test(cell));
}

function alignmentOf(cell) {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u;
const BLOCKQUOTE = /^ {0,3}>\s?/u;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/u;
const LIST_ITEM = /^ {0,3}([-*+]|\d+[.)])\s+(.*)$/u;

function startsBlock(line, next) {
  if (line.trim() === '') return true;
  if (isFence(line) !== null) return true;
  if (HEADING.test(line)) return true;
  if (HR.test(line)) return true;
  if (BLOCKQUOTE.test(line)) return true;
  if (LIST_ITEM.test(line)) return true;
  if (line.includes('|') && next !== undefined && isTableSeparator(next)) return true;
  return false;
}

export function markdownToHtml(raw, lang = 'en') {
  if (typeof raw !== 'string' || raw === '') return '';
  const lines = raw.replace(/\r\n?/gu, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = isFence(line);
    if (fence !== null) {
      i++;
      const body = [];
      while (i < lines.length && !isClosingFence(lines[i], fence)) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // closing fence
      const language = fence.info.split(/\s+/u)[0];
      const cls = language ? ` class="language-${escapeAttr(language)}"` : '';
      out.push(`<pre class="dsh-code"><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2], lang)}</h${level}>`);
      i++;
      continue;
    }

    if (HR.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    if (BLOCKQUOTE.test(line)) {
      const body = [];
      while (i < lines.length && (BLOCKQUOTE.test(lines[i]) || (lines[i].trim() === '' && BLOCKQUOTE.test(lines[i + 1] ?? '')))) {
        body.push(lines[i].replace(BLOCKQUOTE, ''));
        i++;
      }
      out.push(`<blockquote>${markdownToHtml(body.join('\n'), lang)}</blockquote>`);
      continue;
    }

    if (line.includes('|') && isTableSeparator(lines[i + 1] ?? '')) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map(alignmentOf);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const cell = (tag, value, index) => {
        const a = align[index];
        const style = a ? ` style="text-align:${a}"` : '';
        return `<${tag}${style}>${inline(value ?? '', lang)}</${tag}>`;
      };
      const head = `<thead><tr>${header.map((value, index) => cell('th', value, index)).join('')}</tr></thead>`;
      const body = rows.map((row) => `<tr>${header.map((_value, index) => cell('td', row[index] ?? '', index)).join('')}</tr>`).join('');
      out.push(`<table class="dsh-table">${head}<tbody>${body}</tbody></table>`);
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      const ordered = /\d/u.test(item[1]);
      const items = [];
      while (i < lines.length) {
        const current = LIST_ITEM.exec(lines[i]);
        if (current !== null && /\d/u.test(current[1]) === ordered) {
          items.push(current[2]);
          i++;
          continue;
        }
        // Continuation / indented lines belong to the previous item.
        if (items.length > 0 && lines[i].trim() !== '' && /^\s{2,}/u.test(lines[i])) {
          items[items.length - 1] += `\n${lines[i].trim()}`;
          i++;
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((value) => `<li>${inline(value, lang)}</li>`).join('')}</${tag}>`);
      continue;
    }

    // Paragraph: gather until the next block boundary.
    const paragraph = [line];
    i++;
    while (i < lines.length && !startsBlock(lines[i], lines[i + 1])) {
      paragraph.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(paragraph.join('\n'), lang)}</p>`);
  }

  return out.join('\n');
}
