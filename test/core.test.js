import test from 'node:test';
import assert from 'node:assert/strict';

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
          { type: 'text', text: '答案是 42' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' },
        ],
      },
    }, { seq: 3, time: 1200 }),
    surface('tool/result', {
      turn: 1,
      step: 2,
      message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'file1 file2' }] },
    }, { seq: 4 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 5 }),
    ev('turn/start', { turn: 2 }, { seq: 6 }),
    surface('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: {} }] }, { seq: 7 }),
    ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, { seq: 8 }),
    ev('session/title', { title: '测试对话' }, { seq: 9 }),
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

test('ignores non-user injected messages and injection-only turns', () => {  const events = [
    ev('turn/start', { turn: 1 }, { seq: 1 }),
    surface('user/message', { role: 'user', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'injected' }] }, { seq: 2 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 3 }),
  ];
  const { entries, stats } = extractConversation(events);
  assert.equal(entries.length, 0);
  assert.equal(stats.injectedUserMessages, 1);
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

test('skips replacement surface events outside a turn bracket (rewind/compaction)', () => {
  const events = [
    surface('user/message', { role: 'user', source: { kind: 'dsh-rewind' }, content: [{ type: 'text', text: 'rewound' }] }, { seq: 1, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } }),
    ev('turn/start', { turn: 1 }, { seq: 2 }),
    surface('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }, { seq: 3 }),
    surface('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'yo' }] } }, { seq: 4 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, { seq: 5 }),
  ];
  const { entries, stats } = extractConversation(events);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].assistant, 'yo');
  assert.ok(stats.replacements >= 1);
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
