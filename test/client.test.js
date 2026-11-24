import test from 'node:test';
import assert from 'node:assert/strict';

// Load the browser client module under a minimal stub so its pure helpers can be
// tested in Node.
let captured;
globalThis.window = { __ModuleLoader__: { load: (spec) => { captured = spec; } } };
await import('../client.js');

const ReactStub = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  createElement: () => null,
};
const jsxRuntimeStub = { jsx: () => null, jsxs: () => null };
const plugin = captured.factory((id) => {
  if (id === 'react') return ReactStub;
  if (id === 'react/jsx-runtime') return jsxRuntimeStub;
  if (id === 'react-dom') return { createPortal: (node) => node };
  throw new Error('unexpected require ' + id);
});

test('client module registers the header utilities slot', () => {
  assert.equal(captured.id, 'dsh-chat-export');
  assert.deepEqual(plugin.inject, ['slots', 'locale']);
  const registered = [];
  const ctx = {
    slots: {
      inject(owner, fn) { registered.push(owner); fn(); },
      register(options) { registered.push(options); return () => {}; },
    },
  };
  plugin.apply(ctx);
  assert.ok(registered.includes('conversation.session.header.utilities'));
});

test('shortId strips the session prefix and keeps the UUID fragment', () => {
  const { shortId } = plugin.__test;
  assert.equal(shortId('session-7cdd3966-28a1-4735-8dae-903df0cd56b8'), '7cdd3966');
  assert.equal(shortId('abc12345-extra'), 'abc12345');
  assert.equal(shortId('short'), 'short');
});

test('compactSelection uses include/exclude and bits', () => {
  const { compactSelection } = plugin.__test;
  assert.deepEqual(compactSelection(new Set([0, 1]), 4), { include: [0, 1], count: 4 });
  assert.deepEqual(compactSelection(new Set([0, 1, 2]), 4), { exclude: [3], count: 4 });
  const big = new Set();
  for (let i = 0; i < 1000; i++) big.add(i * 2);
  const result = compactSelection(big, 2000);
  assert.ok(typeof result.bits === 'string' && result.count === 2000);
});

test('PDF raster style wraps long code lines', () => {
  const { cssForRaster } = plugin.__test;
  assert.ok(cssForRaster('.dsh-export{}').includes('white-space:pre-wrap'));
});

test('assemblePdf produces a multi-page PDF structure', async () => {
  const { assemblePdf } = plugin.__test;
  const page = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 1588, height: 2246 };
  const blob = assemblePdf([page, page]);
  assert.equal(blob.type, 'application/pdf');
  const text = await blob.text();
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.includes('/Type /Catalog'));
  assert.ok(text.includes('/Type /Pages'));
  assert.ok(text.includes('/Count 2'));
  assert.ok(text.includes('/Subtype /Image'));
  assert.ok(text.includes('DCTDecode'));
  assert.ok(text.includes('startxref'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
});

test('xhtmlBody self-closes void tags for foreignObject', () => {
  const { xhtmlBody } = plugin.__test;
  assert.equal(xhtmlBody('a<br>b<hr><img src="x">'), 'a<br/>b<hr/><img src="x"/>');
});

test('print fallback wraps the expanded PDF fragment', () => {
  const { printDocumentFromFragment } = plugin.__test;
  const html = printDocumentFromFragment({
    title: 'T',
    bodyHtml: '<details class="dsh-details" open><summary>Thinking</summary>body</details>',
    style: '.dsh-export{color:red}',
  });
  assert.ok(html.includes('<body class="dsh-export">'));
  assert.ok(html.includes('<details class="dsh-details" open>'));
  assert.ok(html.includes('.dsh-export{color:red}'));
});

test('analyzePage does not treat a sparse glyph row as blank', () => {
  const { analyzePage } = plugin.__test;
  const width = 40;
  const height = 3000;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 100; y < 124; y++) {
    const i = (y * width + 10) * 4;
    data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;
  }
  const canvas = { width, height, getContext: () => ({ getImageData: () => ({ data }) }) };
  const info = analyzePage(canvas);
  assert.equal(info.blank, false);
  assert.ok(info.contentBottomCss > 0);
});

test('analyzePage picks a cut inside a uniform blank band', () => {
  const { analyzePage } = plugin.__test;
  const width = 40;
  const height = 3000;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const isTextRow = (y) => (y % 60) < 24;
  for (let y = 0; y < height; y++) {
    if (!isTextRow(y)) continue;
    const base = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (x % 4 >= 2) continue;
      const i = base + x * 4;
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;
    }
  }
  const canvas = { width, height, getContext: () => ({ getImageData: () => ({ data }) }) };
  const info = analyzePage(canvas);
  assert.equal(info.blank, false);
  assert.ok(info.cutCss !== null);
  // Page window is 0.5*A4H .. A4H in CSS px; cut must be inside that window.
  assert.ok(info.cutCss >= 1123 * 0.5 - 1 && info.cutCss <= 1123 + 1);
  // The cut row (in device px) must be a blank row, never a text row.
  const cutRow = Math.round(info.cutCss * 2);
  assert.equal(isTextRow(cutRow), false, 'cut must land on a blank row');
  // contentBottom should roughly match the last text row.
  assert.ok(Math.abs(info.contentBottomCss - (height - 1) / 2) < 40);
});

test('translates UI strings for the active DSH locale', () => {
  const dicts = {};
  let active = 'en';
  const locale = {
    register(ns, code, dict) { dicts[code] = dict; return () => {}; },
    bind() { return (key) => (dicts[active] && dicts[active][key]) || key; },
    getLocale() { return { active, revision: 0 }; },
    getSnapshot() { return { active, revision: 0 }; },
    subscribe() { return () => {}; },
  };
  const ctx = {
    get(name) { return name === 'locale' ? locale : undefined; },
    effect(fn) { return fn(); },
    slots: { inject(_owner, fn) { fn(); }, register() { return () => {}; } },
  };
  plugin.apply(ctx);
  const { translate, currentLang } = plugin.__test;
  assert.equal(currentLang(), 'en');
  assert.equal(translate('btnExport'), 'Export chat');
  active = 'zh';
  assert.equal(currentLang(), 'zh');
  assert.equal(translate('btnExport'), '导出对话');
});

test('i18n dictionaries have matching keys in en and zh', () => {
  const { i18nDict } = plugin.__test;
  const en = Object.keys(i18nDict.en).sort();
  const zh = Object.keys(i18nDict.zh).sort();
  assert.deepEqual(en, zh);
  assert.ok(en.includes('btnExport'));
  assert.ok(en.includes('sessionsError'));
  assert.ok(en.includes('loadingSessions'));
  for (const key of en) {
    assert.ok(typeof i18nDict.en[key] === 'string' && i18nDict.en[key].length > 0, 'en ' + key);
    assert.ok(typeof i18nDict.zh[key] === 'string' && i18nDict.zh[key].length > 0, 'zh ' + key);
  }
});

test('assemblePdf scales a short page image to its own aspect ratio', async () => {
  const { assemblePdf } = plugin.__test;
  const shortPage = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 1588, height: 800 };
  const text = await assemblePdf([shortPage]).text();
  const content = /q 595 0 0 ([\d.]+) 0 ([\d.]+) cm \/Im0 Do Q/.exec(text);
  assert.ok(content, 'content stream present');
  const drawnHeight = Number(content[1]);
  const yOffset = Number(content[2]);
  assert.ok(drawnHeight < 842 && drawnHeight > 0);
  assert.ok(Math.abs(drawnHeight + yOffset - 842) < 0.01);
});
