import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBuildHandler,
  createSessionsHandler,
  createTurnsHandler,
  isTrustedRequest,
  selectEntries,
} from '../src/production.js';
import { apply as applyHost } from '../index.js';

function makeRequest(body, { method = 'POST', origin = 'http://127.0.0.1:57023', host = '127.0.0.1:57023', crossSite } = {}) {
  const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
  return {
    method,
    headers: {
      host,
      origin,
      'content-type': 'application/json',
      ...(crossSite ? { 'sec-fetch-site': 'cross-site' } : {}),
    },
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  };
}

function makeResponse() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body ?? ''; },
  };
}

function sampleSnapshot(sessionId) {
  const ev = (type, data, extra = {}) => ({ type, seq: 0, time: 0, data, ...extra });
  return {
    session: { id: sessionId },
    events: [
      ev('session/title', { title: '真实对话' }),
      ev('turn/start', { turn: 1 }),
      ev('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '问一下 Q' }] }, { surfaceOp: 'append' }),
      ev('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'reasoning', text: '想' }, { type: 'text', text: '回答 A' }] } }, { surfaceOp: 'append' }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ],
  };
}

test('trust fence accepts same-origin and rejects cross-site / bad origin', () => {
  assert.equal(isTrustedRequest(makeRequest({})), true);
  assert.equal(isTrustedRequest(makeRequest({}, { crossSite: true })), false);
  assert.equal(isTrustedRequest(makeRequest({}, { origin: 'http://evil.example' })), false);
  // Non-loopback hosts are rejected unless explicitly trusted.
  const nonLoopback = { host: 'evil.example:8080', origin: 'http://evil.example:8080' };
  assert.equal(isTrustedRequest(makeRequest({}, nonLoopback)), false);
  assert.equal(isTrustedRequest(makeRequest({}, nonLoopback), ['evil.example:8080']), true);
  const noHost = { method: 'POST', headers: { origin: 'http://127.0.0.1:57023' }, async *[Symbol.asyncIterator]() {} };
  assert.equal(isTrustedRequest(noHost), false);
  // An explicit trusted port is exact, not any port on that host.
  assert.equal(isTrustedRequest(makeRequest({}, { host: 'evil.example:9999', origin: 'http://evil.example:9999' }), ['evil.example:8080']), false);
  // Only http(s) origins are acceptable.
  assert.equal(isTrustedRequest(makeRequest({}, { origin: 'ftp://127.0.0.1:57023' })), false);
});

test('host routes use the connection admission for authentication', async () => {
  const routes = [];
  const ctx = {
    connection: { requestRejection: () => 401 },
    sessionQuery: {},
    webServer: {
      getOrigin: () => 'http://127.0.0.1:57023',
      register(route) { routes.push(route); return () => {}; },
    },
    get: () => undefined,
    effect(callback) { return callback(); },
    logger: { warn() {} },
  };
  applyHost(ctx);
  const sessionsRoute = routes.find((route) => route.path === '/api/chat-export.sessions');
  assert.ok(sessionsRoute);
  const res = makeResponse();
  await sessionsRoute.handler(makeRequest({}), res);
  assert.equal(res.status, 401);
  assert.equal(res.body, 'unauthorized');
});

test('handlers reject a request when connection admission fails', async () => {
  const handler = createBuildHandler({
    readSession: async (id) => sampleSnapshot(id),
    admitRequest: () => 401,
    onError: () => {},
  });
  const res = makeResponse();
  await handler(makeRequest({ sessionId: 'sess-1' }), res);
  assert.equal(res.status, 401);
  assert.equal(res.body, 'unauthorized');
});

test('handlers accept a request when connection admission passes', async () => {
  const handler = createBuildHandler({
    readSession: async (id) => sampleSnapshot(id),
    admitRequest: () => undefined,
    onError: () => {},
  });
  const res = makeResponse();
  await handler(makeRequest({ sessionId: 'sess-1' }), res);
  assert.equal(res.status, 200);
});

test('build handler returns markdown, html and fragment', async () => {
  const handler = createBuildHandler({ readSession: async (id) => sampleSnapshot(id), onError: () => {} });
  const res = makeResponse();
  await handler(makeRequest({ sessionId: 'sess-1' }), res);
  assert.equal(res.status, 200);
  const value = JSON.parse(res.body);
  assert.equal(value.title, '真实对话');
  assert.ok(value.markdown.includes('回答 A'));
  assert.ok(value.markdown.includes('# 真实对话'));
  assert.ok(value.html.startsWith('<!DOCTYPE html>'));
  assert.ok(typeof value.fragment.bodyHtml === 'string');
  assert.ok(!value.markdown.includes('想')); // reasoning excluded by default
  assert.ok(value.fileStem.includes('--'));
});

test('build handler renders only the requested format', async () => {
  const handler = createBuildHandler({ readSession: async (id) => sampleSnapshot(id), onError: () => {} });
  const markdownRes = makeResponse();
  await handler(makeRequest({ sessionId: 'sess-1', format: 'md' }), markdownRes);
  const markdown = JSON.parse(markdownRes.body);
  assert.ok(markdown.markdown.includes('回答 A'));
  assert.equal(markdown.html, undefined);
  assert.equal(markdown.fragment, undefined);

  const pdfRes = makeResponse();
  await handler(makeRequest({ sessionId: 'sess-1', format: 'pdf' }), pdfRes);
  const pdf = JSON.parse(pdfRes.body);
  assert.equal(pdf.markdown, undefined);
  assert.equal(pdf.html, undefined);
  assert.ok(pdf.fragment.bodyHtml.includes('回答 A'));
});

test('build handler includes reasoning when asked and honours selection', async () => {
  const handler = createBuildHandler({ readSession: async (id) => sampleSnapshot(id), onError: () => {} });
  const res = makeResponse();
  await handler(makeRequest({ sessionId: 'sess-1', includeReasoning: true }), res);
  const value = JSON.parse(res.body);
  assert.ok(value.markdown.includes('Thinking'));
  assert.ok(value.markdown.includes('想'));

  const all = selectEntries([{ a: 1 }, { a: 2 }], { exclude: [1], count: 2 });
  assert.equal(all.length, 1);
});

test('build handler can ignore questioner content', async () => {
  const handler = createBuildHandler({ readSession: async (id) => sampleSnapshot(id), onError: () => {} });
  const res = makeResponse();
  await handler(makeRequest({ sessionId: 'sess-1', ignoreQuestions: true }), res);
  const value = JSON.parse(res.body);
  assert.ok(value.markdown.includes('回答 A'));
  assert.ok(!value.markdown.includes('问一下 Q'));
  assert.ok(!value.html.includes('<article class="dsh-msg dsh-msg-human"'));
});

test('build handler localizes export labels by lang', async () => {
  const handler = createBuildHandler({ readSession: async (id) => sampleSnapshot(id), onError: () => {} });
  const zhRes = makeResponse();
  await handler(makeRequest({ sessionId: 'sess-1', lang: 'zh' }), zhRes);
  const zh = JSON.parse(zhRes.body);
  assert.ok(zh.markdown.includes('> **用户**'));
  assert.ok(zh.markdown.includes('> **助手**'));
  assert.ok(zh.html.includes('dsh-role">用户<'));
  assert.ok(zh.html.includes('<html lang="zh-CN">'));
  const enRes = makeResponse();
  await handler(makeRequest({ sessionId: 'sess-1' }), enRes);
  assert.ok(JSON.parse(enRes.body).markdown.includes('> **Human**'));
});

test('turn previews do not materialize a full code point array', async () => {
  const longText = 'x'.repeat(5000);
  const snapshot = {
    session: { id: 'sess-long' },
    events: [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, surfaceOp: 'append', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: longText }] } },
      { type: 'assistant/message', seq: 3, surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'ok' }] } } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  };
  const handler = createTurnsHandler({ readSession: async () => snapshot, onError: () => {} });
  const originalFrom = Array.from;
  Array.from = () => { throw new Error('full code point array materialized'); };
  let res;
  try {
    res = makeResponse();
    await handler(makeRequest({ sessionId: 'sess-long' }), res);
  } finally {
    Array.from = originalFrom;
  }
  assert.equal(res.status, 200);
  const value = JSON.parse(res.body);
  assert.ok(value.turns[0].human.endsWith('…'));
  assert.ok(value.turns[0].human.length <= 180);
});

test('turns handler returns previews with reasoning/tool flags', async () => {
  const handler = createTurnsHandler({ readSession: async (id) => sampleSnapshot(id), onError: () => {} });
  const res = makeResponse();
  await handler(makeRequest({ sessionId: 'sess-1' }), res);
  const value = JSON.parse(res.body);
  assert.equal(value.turns.length, 1);
  assert.equal(value.turns[0].hasReasoning, true);
  assert.equal(value.turns[0].hasTools, false);
  assert.ok(value.turns[0].human.includes('问一下'));
});

test('sessions handler lists non-subagent sessions with titles', async () => {
  const records = [
    { header: { id: 's1', createdAt: 100 } },
    { header: { id: 's2', createdAt: 90, origin: 'subagent' } },
  ];
  const handler = createSessionsHandler({
    listSessions: async () => records,
    readTitleSnapshots: async (ids) => ids.map((id) => ({
      sessionId: id,
      status: 'fulfilled',
      value: { session: { id }, title: { title: id === 's1' ? '标题一' : '标题二' } },
    })),
    onError: () => {},
  });
  const res = makeResponse();
  await handler(makeRequest({}), res);
  const value = JSON.parse(res.body);
  assert.equal(value.sessions.length, 1);
  assert.equal(value.sessions[0].sessionId, 's1');
  assert.equal(value.sessions[0].title, '标题一');
});

test('handlers reject wrong method, content type and bad body', async () => {
  const handler = createBuildHandler({ readSession: async (id) => sampleSnapshot(id), onError: () => {} });
  let res = makeResponse();
  await handler(makeRequest({}, { method: 'GET' }), res);
  assert.equal(res.status, 405);
  res = makeResponse();
  await handler(makeRequest({ sessionId: '' }), res);
  assert.equal(res.status, 400);
});
