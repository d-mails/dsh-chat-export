import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { extractConversation } from '../src/extract.js';
import { renderMarkdown, renderHtmlDocument, renderHtmlFragment, expandUiFences } from '../src/render.js';
import { markdownToHtml } from '../src/md-html.js';
import { selectEntries } from '../src/production.js';
import { fileStem } from '../src/filename.js';

function ev(type, data, extra = {}) {
  return { type, seq: extra.seq ?? 0, time: extra.time ?? 0, data, ...extra };
}

function surface(type, data, extra = {}) {
  return ev(type, data, { surfaceOp: 'append', ...extra });
}

function sampleEvents() {
  return [
    ev('turn/start', { turn: 1 }, { seq: 1, time: 1000 }),
    surface('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好 **世界**' }] }, { seq: 2 }),
    surface('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        source: { kind: 'model', provider: 'p', model: 'm' },
        content: [
          { type: 'reasoning', text: '先想一想' },
          { type: 'text', text: '先查一下' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' },
        ],
      },
    }, { seq: 3, time: 1200 }),
    surface('tool/result', {
      turn: 1,
      step: 2,
      message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'file1 file2' }] },
    }, { seq: 4 }),
    surface('assistant/message', {
      turn: 1,
      step: 3,
      message: {
        role: 'assistant',
        source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'text', text: '答案是 42' }],
      },
    }, { seq: 5, time: 1300 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 6 }),
    ev('turn/start', { turn: 2 }, { seq: 7 }),
    surface('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: {} }] }, { seq: 8 }),
    ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, { seq: 9 }),
    ev('session/title', { title: '测试对话' }, { seq: 10 }),
  ];
}

test('extracts human turns and final answers, skipping reasoning by default', () => {
  const { title, entries, stats } = extractConversation(sampleEvents());
  assert.equal(title, '测试对话');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].humans[0], '你好 **世界**');
  assert.equal(entries[0].assistant, '答案是 42');
  assert.equal(entries[0].reasoning, null);
  assert.deepEqual(entries[0].tools, []);
  assert.equal(entries[1].humans[0], '[Image omitted]');
  assert.equal(entries[1].assistant, null);
  assert.ok(stats.reasoningBlocks >= 1);
});

test('includes reasoning and tool calls when requested', () => {
  const { entries } = extractConversation(sampleEvents(), { includeReasoning: true, includeTools: true });
  assert.equal(entries[0].reasoning, '先想一想');
  assert.equal(entries[0].tools.length, 1);
  assert.equal(entries[0].tools[0].name, 'bash');
  assert.equal(entries[0].tools[0].result, 'file1 file2');
  assert.equal(entries[0].tools[0].isError, false);
});

test('does not treat an intermediate assistant message with tool calls as the final answer', () => {
  const events = [
    ev('turn/start', { turn: 1 }, { seq: 1 }),
    surface('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }] }, { seq: 2 }),
    surface('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model' }, content: [
      { type: 'text', text: 'let me check' },
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
    ] } }, { seq: 3 }),
    surface('tool/result', { turn: 1, step: 2, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } }, { seq: 4 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 5 }),
  ];
  const { entries, stats } = extractConversation(events);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].assistant, null);
  assert.equal(stats.finalAssistants, 0);
});

test('prefers the last assistant message when it is a final reply after tool calls', () => {
  const events = [
    ev('turn/start', { turn: 1 }, { seq: 1 }),
    surface('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }] }, { seq: 2 }),
    surface('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model' }, content: [
      { type: 'text', text: 'let me check' },
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
    ] } }, { seq: 3 }),
    surface('tool/result', { turn: 1, step: 2, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } }, { seq: 4 }),
    surface('assistant/message', { turn: 1, step: 3, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'final answer' }] } }, { seq: 5 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 6 }),
  ];
  const { entries } = extractConversation(events);
  assert.equal(entries[0].assistant, 'final answer');
});

test('tool result truncation does not materialize a full code point array', () => {
  const events = [
    ev('turn/start', { turn: 1 }, { seq: 1 }),
    surface('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }] }, { seq: 2 }),
    surface('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model' }, content: [
      { type: 'text', text: 'check' },
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
    ] } }, { seq: 3 }),
    surface('tool/result', { turn: 1, step: 2, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'y'.repeat(5000) }] } }, { seq: 4 }),
    surface('assistant/message', { turn: 1, step: 3, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'done' }] } }, { seq: 5 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 6 }),
  ];
  const originalFrom = Array.from;
  Array.from = () => { throw new Error('full code point array materialized'); };
  let result;
  try {
    result = extractConversation(events, { includeTools: true });
  } finally {
    Array.from = originalFrom;
  }
  assert.equal(result.entries[0].tools[0].result.includes('more characters'), true);
});

test('a tool/call event after commentary invalidates the final answer', () => {
  const events = [
    ev('turn/start', { turn: 1 }, { seq: 1 }),
    surface('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }] }, { seq: 2 }),
    surface('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'commentary' }] } }, { seq: 3 }),
    ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }, { seq: 4 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 5 }),
  ];
  const { entries } = extractConversation(events);
  assert.equal(entries[0].assistant, null);
});

test('ignores non-user injected messages and injection-only turns', () => {  const events = [
    ev('turn/start', { turn: 1 }, { seq: 1 }),
    surface('user/message', { role: 'user', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'injected' }] }, { seq: 2 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 3 }),
  ];
  const { entries, stats } = extractConversation(events);
  assert.equal(entries.length, 0);
  assert.equal(stats.injectedUserMessages, 1);
});

test('metadata-only extraction keeps flags while truncating text', () => {
  const events = [
    ev('turn/start', { turn: 1 }, { seq: 1 }),
    surface('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q'.repeat(1000) }] }, { seq: 2 }),
    surface('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model' }, content: [
      { type: 'reasoning', text: 'r'.repeat(1000) },
      { type: 'text', text: 's'.repeat(1000) },
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: 'x'.repeat(1000) },
    ] } }, { seq: 3 }),
    surface('assistant/message', { turn: 1, step: 2, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'final' }] } }, { seq: 4 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 5 }),
  ];
  const { entries } = extractConversation(events, {
    includeReasoning: false,
    includeTools: false,
    metadataOnly: true,
    maxTextChars: 40,
  });
  assert.equal(entries[0].hasReasoning, true);
  assert.equal(entries[0].hasTools, true);
  assert.ok(entries[0].humans[0].length < 1000);
  assert.ok(entries[0].assistant.length < 1000);
});

test('renders image and file attachments as readable labels', () => {
  const events = [
    ev('turn/start', { turn: 1 }, { seq: 1 }),
    surface('user/message', {
      role: 'user',
      source: { kind: 'user' },
      content: [
        { type: 'image', attachment: { name: 'photo.png', width: 640, height: 480, bytes: 1234 } },
        { type: 'file', attachment: { name: 'notes.pdf', bytes: 5678 } },
      ],
    }, { seq: 2 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 3 }),
  ];
  const { entries } = extractConversation(events);
  assert.equal(entries[0].humans[0], '[Image: photo.png (640×480, 1234 bytes)]\n\n[File: notes.pdf (5678 bytes)]');
});

test('treats a goal source message as a human turn', () => {
  const events = [
    ev('turn/start', { turn: 1 }, { seq: 1 }),
    surface('user/message', { role: 'user', source: { kind: 'goal' }, content: [{ type: 'text', text: '<goal_round>\nObjective: "研究导出插件"' }] }, { seq: 2 }),
    surface('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'done' }] } }, { seq: 3 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 4 }),
  ];
  const { entries } = extractConversation(events);
  assert.equal(entries.length, 1);
  assert.ok(entries[0].humans[0].includes('研究导出插件'));
  assert.equal(entries[0].assistant, 'done');
});

test('closes an open fenced code block at message end', () => {
  const events = [
    ev('turn/start', { turn: 1 }, { seq: 1 }),
    surface('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }, { seq: 2 }),
    surface('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'code:\n```js\nconst a = 1;' }] } }, { seq: 3 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 4 }),
  ];
  const { entries } = extractConversation(events);
  const markdown = renderMarkdown(entries, 'T');
  assert.ok(markdown.includes('const a = 1;\n```'));
});

test('tool results with triple backticks cannot escape their fenced block', () => {
  const entries = [{
    turn: 1,
    humans: ['q'],
    assistant: 'a',
    reasoning: null,
    tools: [{
      name: 'bash',
      arguments: '{}',
      result: 'before\n```\n## INJECTED\n[click](https://evil.example)\n```',
      isError: false,
    }],
  }];
  const markdown = renderMarkdown(entries, 'T');
  assert.ok(markdown.includes('````text'));
  assert.ok(markdown.indexOf('## INJECTED') < markdown.indexOf('</details>'));
});

test('reasoning text cannot close the generated details wrapper', () => {
  const entries = [{
    turn: 1,
    humans: ['q'],
    assistant: 'a',
    reasoning: 'before\n</details>\n# after',
    tools: [],
  }];
  const markdown = renderMarkdown(entries, 'T');
  assert.ok(markdown.includes('&lt;/details>'));
  assert.ok(!markdown.includes('\n</details>\n# after'));
});

test('markdownToHtml renders common blocks and escapes html', () => {
  const html = markdownToHtml('# 标题\n\n正文 **粗** *斜* `code` <script>x</script>\n\n- a\n- b\n\n```py\nprint(1)\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.ok(html.includes('<h1>标题</h1>'));
  assert.ok(html.includes('<strong>粗</strong>'));
  assert.ok(html.includes('<em>斜</em>'));
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('<ul>'));
  assert.ok(html.includes('language-py'));
  assert.ok(html.includes('<table class="dsh-table">'));
  assert.ok(html.includes('<td>1</td>'));
});

test('links allow http and reject javascript urls', () => {
  const ok = markdownToHtml('[a](https://example.com)');
  assert.ok(ok.includes('href="https://example.com"'));
  const bad = markdownToHtml('[a](javascript:alert(1))');
  assert.ok(!/href="javascript:/iu.test(bad));
});

test('underscores inside words are not emphasis', () => {
  const html = markdownToHtml('snake_case_name');
  assert.ok(!html.includes('<em>'));
  assert.ok(html.includes('snake_case_name'));
});

test('link destinations may contain balanced parentheses', () => {
  const html = markdownToHtml('[x](https://example.com/a_(b))');
  assert.ok(html.includes('href="https://example.com/a_(b)"'));
  assert.ok(html.includes('>x</a>'));
});

test('bare autolinks escape quotes in href attributes', () => {
  const html = markdownToHtml('https://example.com/"onmouseover="alert(1)');
  assert.ok(!html.includes('href="https://example.com/"onmouseover'));
  assert.ok(html.includes('&quot;onmouseover=&quot;'));
  const ok = markdownToHtml('https://example.com/a?x=1&y=2');
  assert.ok(ok.includes('href="https://example.com/a?x=1&amp;y=2"'));
});

test('image note localizes', () => {
  assert.ok(markdownToHtml('![alt](u)').includes('[Image: alt]'));
  assert.ok(markdownToHtml('![alt](u)', 'zh').includes('[图片：alt]'));
});

test('empty Markdown output uses the localized empty notice and fallback title', () => {
  const en = renderMarkdown([], null);
  assert.ok(en.includes('DSH Conversation'));
  assert.ok(en.includes('No conversation content to export.'));
  const zh = renderMarkdown([], null, { lang: 'zh' });
  assert.ok(zh.includes('DSH 对话'));
  assert.ok(zh.includes('没有可导出的对话内容。'));
});

test('renderMarkdown tolerates entries without a humans array', () => {
  const markdown = renderMarkdown([{ turn: 1, assistant: 'answer', reasoning: null, tools: [] }], 'T');
  assert.ok(markdown.includes('answer'));
});

test('HTML output shows the empty notice when every entry is filtered', () => {
  const html = renderHtmlDocument([{ turn: 1, humans: [], assistant: null, reasoning: null, tools: [] }], 'T');
  assert.ok(html.includes('No conversation content to export.'));
});

test('English locale metadata contains no Chinese copy', () => {
  const locale = JSON.parse(fs.readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'));
  assert.ok(!/[\u4e00-\u9fff]/u.test(locale.meta.description));
});

test('renderHtmlDocument is a full document and renderHtmlFragment returns parts', () => {
  const { entries } = extractConversation(sampleEvents(), { includeReasoning: true, includeTools: true });
  const doc = renderHtmlDocument(entries, '测试');
  assert.ok(doc.startsWith('<!DOCTYPE html>'));
  assert.ok(doc.includes('dsh-msg-human'));
  assert.ok(doc.includes('Thinking'));
  const frag = renderHtmlFragment(entries, '测试');
  assert.ok(typeof frag.bodyHtml === 'string');
  assert.ok(frag.style.includes('.dsh-export'));
});

test('renderHtmlFragment opens reasoning and tool details for PDF rendering', () => {
  const entries = [{
    turn: 1,
    humans: ['q'],
    assistant: 'a',
    reasoning: 'think',
    tools: [{ name: 'bash', arguments: '{}', result: 'ok', isError: false }],
  }];
  const frag = renderHtmlFragment(entries, 'T');
  assert.ok(frag.bodyHtml.includes('<details class="dsh-details" open>'));
  const doc = renderHtmlDocument(entries, 'T');
  assert.ok(!doc.includes('class="dsh-details" open'));
});

test('selectEntries supports include, exclude and bits', () => {
  const entries = [{}, {}, {}, {}];
  assert.equal(selectEntries(entries).length, 4);
  assert.equal(selectEntries(entries, { include: [0, 2], count: 4 }).length, 2);
  assert.equal(selectEntries(entries, { exclude: [1], count: 4 }).length, 3);
  const bytes = new Uint8Array([0b00000101]); // bits 0 and 2
  const bits = Buffer.from(bytes).toString('base64');
  assert.equal(selectEntries(entries, { bits, count: 4 }).length, 2);
  assert.throws(() => selectEntries(entries, { include: [], count: 4 }));
});

test('ignores unknown surface event types instead of failing the export', () => {
  const events = [
    ev('turn/start', { turn: 1 }, { seq: 1 }),
    surface('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }] }, { seq: 2 }),
    surface('assistant/notice', { text: 'new event type' }, { seq: 3 }),
    surface('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'a' }] } }, { seq: 4 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 5 }),
  ];
  const { entries, stats } = extractConversation(events);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].assistant, 'a');
  assert.ok(stats.unknownEvents >= 1);
});

test('ignores system and developer surface messages, even outside a turn', () => {
  const events = [
    surface('system/message', { role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'prompt' }] }, { seq: 1 }),
    surface('developer/message', { role: 'developer', source: { kind: 'user' }, content: [{ type: 'text', text: 'dev' }] }, { seq: 2 }),
    ev('turn/start', { turn: 1 }, { seq: 3 }),
    surface('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }, { seq: 4 }),
    surface('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'hey' }] } }, { seq: 5 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 6 }),
  ];
  const { entries } = extractConversation(events);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].humans[0], 'hi');
  assert.equal(entries[0].assistant, 'hey');
});

test('dsh-ui fences become readable tables instead of raw JSON', () => {
  const spec = {
    title: '要点',
    items: [
      { type: 'table', columns: ['项目', '标准'], rows: [['基数', '4354 元'], ['费率', '20%']] },
      { type: 'keyvalue', pairs: [{ key: '日期', value: '2026.1.1' }] },
      { type: 'callout', tone: 'info', content: '提示内容' },
    ],
  };
  const source = '前置说明\n\n```dsh-ui\n' + JSON.stringify(spec) + '\n```';
  const expanded = expandUiFences(source);
  assert.ok(expanded.includes('| 项目 | 标准 |'));
  assert.ok(expanded.includes('| 基数 | 4354 元 |'));
  assert.ok(expanded.includes('**日期**'));
  assert.ok(!expanded.includes('"type"'));
  assert.ok(!expanded.includes('dsh-ui'));

  const entries = [{ turn: 1, humans: ['问题'], assistant: source, reasoning: null, tools: [] }];
  const md = renderMarkdown(entries, 'T');
  assert.ok(md.includes('| 项目 | 标准 |'));
  assert.ok(!md.includes('"columns"'));
  const html = renderHtmlDocument(entries, 'T');
  assert.ok(html.includes('<table class="dsh-table">'));
  assert.ok(!html.includes('&quot;columns&quot;'));
});

test('unparseable dsh-ui fence degrades to a note', () => {
  const out = expandUiFences('```dsh-ui\n{not json}\n```');
  assert.ok(out.includes('Interactive component'));
  assert.ok(!out.includes('dsh-ui'));
});

test('dsh-ui chart fences become a readable table', () => {
  const spec = {
    title: 'Chart',
    items: [{ type: 'chart', kind: 'bars', data: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }] }],
  };
  const expanded = expandUiFences('```dsh-ui\n' + JSON.stringify(spec) + '\n```');
  assert.ok(expanded.includes('| Label | Value |'));
  assert.ok(expanded.includes('| A | 1 |'));
  assert.ok(expanded.includes('| B | 2 |'));
});

test('dsh-ui fences inside another code block are not expanded', () => {
  const source = '```md\n```dsh-ui\n{"items":[]}\n```\n```';
  const expanded = expandUiFences(source);
  assert.ok(expanded.includes('```dsh-ui'));
});

test('markdownToHtml keeps escaped table pipes inside one cell', () => {
  const html = markdownToHtml('| a | b |\n|---|---|\n| x \\| y | z |');
  assert.ok(html.includes('<td>x | y</td>'));
  assert.ok(html.includes('<td>z</td>'));
});

test('hides messages covered by a rewind replacement range', () => {
  const events = [
    ev('turn/start', { turn: 1 }, { seq: 1 }),
    surface('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'old question' }] }, { seq: 2 }),
    surface('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'old answer' }] } }, { seq: 3 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 4 }),
    surface('user/message', { role: 'user', source: { kind: 'dsh-rewind' }, content: [{ type: 'text', text: '(empty message)' }] }, { seq: 5, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 } }),
    ev('turn/start', { turn: 2 }, { seq: 6 }),
    surface('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'new question' }] }, { seq: 7 }),
    surface('assistant/message', { turn: 2, step: 1, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'new answer' }] } }, { seq: 8 }),
    ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, { seq: 9 }),
  ];
  const { entries, stats } = extractConversation(events);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].humans, ['new question']);
  assert.equal(entries[0].assistant, 'new answer');
  assert.ok(stats.replacements >= 1);
});

test('keeps earlier messages covered by a compaction checkpoint', () => {
  const events = [
    ev('turn/start', { turn: 1 }, { seq: 1 }),
    surface('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'old question' }] }, { seq: 2 }),
    surface('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'old answer' }] } }, { seq: 3 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 4 }),
    surface('user/message', { role: 'user', source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: '<compacted-summary>summary</compacted-summary>' }] }, { seq: 5, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 } }),
    ev('turn/start', { turn: 2 }, { seq: 6 }),
    surface('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'new question' }] }, { seq: 7 }),
    surface('assistant/message', { turn: 2, step: 1, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'new answer' }] } }, { seq: 8 }),
    ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, { seq: 9 }),
  ];
  const { entries } = extractConversation(events);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.humans[0]), ['old question', 'new question']);
});

test('renderMarkdown skips entries left with no humans and no assistant', () => {
  const entries = [
    { turn: 1, humans: [], assistant: null, reasoning: null, tools: [] },
    { turn: 2, humans: ['q'], assistant: 'a', reasoning: null, tools: [] },
  ];
  const markdown = renderMarkdown(entries, 'T');
  assert.ok(!markdown.includes('Response incomplete'));
  assert.ok(markdown.includes('a'));
  assert.ok(markdown.includes('q'));
});

test('fileStem is safe and stable', () => {
  const stem = fileStem('abc-1234', 'Hello / World: Test');
  assert.ok(/^Hello-World-Test--/u.test(stem));
  assert.ok(fileStem('x', null).startsWith('dsh-conversation--'));
});
