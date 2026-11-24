/**
 * DSH Chat Export host boundary.
 *
 * Three same-origin POST routes read one live-preferred Session through
 * `sessionQuery` and answer the browser that requested it. No persistence, no
 * outbound network, no telemetry.
 */

import { extractConversation } from './extract.js';
import { fileStem } from './filename.js';
import { renderHtmlDocument, renderHtmlFragment, renderMarkdown } from './render.js';

export const SESSIONS_PATH = '/api/chat-export.sessions';
export const TURNS_PATH = '/api/chat-export.turns';
export const BUILD_PATH = '/api/chat-export.build';

const MAX_REQUEST_BYTES = 65536;
const MAX_SESSIONS = 300;
const MAX_TURN_PREVIEW = 180;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

function header(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : typeof value === 'string' ? value : undefined;
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === undefined) return false;
    // An explicit port is exact; only a port-less entry matches any port.
    if (entryUrl.port !== '') return entryUrl.host === hostUrl.host;
    return entryUrl.hostname === hostUrl.hostname;
  });
}

/**
 * Mirror DSH Web's /api Host/Origin trust fence for a plugin-owned route.
 * The Host must be loopback or a configured trusted host (URL or host[:port]).
 * @param {import('node:http').IncomingMessage} request
 * @param {readonly string[]} trustedHosts
 * @returns {boolean}
 */
export function isTrustedRequest(request, trustedHosts = []) {
  const host = header(request.headers, 'host');
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false;
  const origin = header(request.headers, 'origin');
  if (origin !== undefined) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return false;
      if (originUrl.host !== hostUrl.host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new RequestError(413, 'request is too large');
    chunks.push(buffer);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(400, 'request must be valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError(400, 'request must be a JSON object');
  }
  return value;
}

function sessionIdOf(value) {
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) {
    throw new RequestError(400, 'request requires a non-empty sessionId');
  }
  return value.sessionId;
}

function writeJson(response, status, value) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function writeText(response, status, text, extraHeaders = {}) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(text);
}

async function handle(request, response, trustedHosts, onError, run, admitRequest) {
  if (request.method !== 'POST') {
    writeText(response, 405, 'method not allowed', { Allow: 'POST' });
    return;
  }
  if (typeof admitRequest === 'function') {
    let rejection;
    try {
      rejection = admitRequest(request);
    } catch (error) {
      try {
        onError(error);
      } catch {
        // ignore logging failures
      }
      writeText(response, 500, 'chat export failed');
      return;
    }
    if (rejection === 401 || rejection === 403) {
      writeText(response, rejection, rejection === 401 ? 'unauthorized' : 'forbidden');
      return;
    }
  } else if (!isTrustedRequest(request, trustedHosts)) {
    writeText(response, 403, 'forbidden');
    return;
  }
  const mediaType = header(request.headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    writeText(response, 415, 'content type must be application/json');
    return;
  }
  try {
    await run();
  } catch (error) {
    if (error instanceof RequestError) {
      writeText(response, error.status, error.message);
      return;
    }
    try {
      onError(error);
    } catch {
      // ignore logging failures
    }
    writeText(response, 500, 'chat export failed');
  }
}

function canonicalSnapshot(requestedSessionId, snapshot) {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError('readSession returned no snapshot object');
  }
  if (snapshot.session === null || typeof snapshot.session !== 'object') {
    throw new TypeError('readSession returned no session header');
  }
  if (String(snapshot.session.id) !== requestedSessionId) {
    throw new TypeError('readSession returned a different session');
  }
  if (!Array.isArray(snapshot.events)) {
    throw new TypeError('readSession returned no event array');
  }
  return snapshot;
}

function selectionIndexes(selection, entryCount) {
  if (selection === null || typeof selection !== 'object' || Array.isArray(selection)) {
    throw new RequestError(400, 'turn selection must be a JSON object');
  }
  const hasInclude = Object.hasOwn(selection, 'include');
  const hasExclude = Object.hasOwn(selection, 'exclude');
  const hasBits = Object.hasOwn(selection, 'bits');
  if (hasBits) {
    if (Object.keys(selection).some((key) => key !== 'bits' && key !== 'count')
      || typeof selection.bits !== 'string'
      || selection.count !== entryCount
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(selection.bits)) {
      throw new RequestError(400, 'turn selection contains an invalid bitset');
    }
    const bytes = Buffer.from(selection.bits, 'base64');
    if (bytes.length !== Math.ceil(entryCount / 8) || bytes.toString('base64') !== selection.bits) {
      throw new RequestError(400, 'turn selection contains an invalid bitset');
    }
    const unusedBits = bytes.length * 8 - entryCount;
    if (unusedBits > 0 && (bytes.at(-1) >> (8 - unusedBits)) !== 0) {
      throw new RequestError(400, 'turn selection contains an invalid bitset');
    }
    const included = new Set();
    for (let index = 0; index < entryCount; index++) {
      if ((bytes[index >> 3] & (1 << (index & 7))) !== 0) included.add(index);
    }
    return { mode: 'include', indexes: included };
  }
  if (hasInclude === hasExclude
    || Object.keys(selection).some((key) => key !== 'include' && key !== 'exclude' && key !== 'count')) {
    throw new RequestError(400, 'turn selection must contain exactly one of include or exclude');
  }
  if (selection.count !== entryCount) {
    throw new RequestError(400, 'conversation turns changed; reload the selector');
  }
  const mode = hasInclude ? 'include' : 'exclude';
  const indexes = selection[mode];
  if (!Array.isArray(indexes)) throw new RequestError(400, `turn selection ${mode} must be an array`);
  const unique = new Set();
  for (const index of indexes) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= entryCount) {
      throw new RequestError(400, 'turn selection contains an out-of-range index');
    }
    if (unique.has(index)) throw new RequestError(400, 'turn selection contains a duplicate index');
    unique.add(index);
  }
  return { mode, indexes: unique };
}

export function selectEntries(entries, selection = undefined) {
  if (selection === undefined || selection === null) return entries;
  const { mode, indexes } = selectionIndexes(selection, entries.length);
  const selected = entries.filter((_entry, index) => (mode === 'include' ? indexes.has(index) : !indexes.has(index)));
  if (selected.length === 0) throw new RequestError(400, 'select at least one conversation turn');
  return selected;
}

function shortPreview(value) {
  const readable = String(value).replace(/\s+/gu, ' ').trim();
  let head = '';
  let count = 0;
  for (const character of readable) {
    count++;
    if (count > MAX_TURN_PREVIEW) return `${head}…`;
    if (count <= MAX_TURN_PREVIEW - 1) head += character;
  }
  return readable;
}

export function createSessionsHandler({ listSessions, readTitleSnapshots, trustedHosts = [], onError = () => {}, admitRequest }) {
  return (request, response) => handle(request, response, trustedHosts, onError, async () => {
    let records = await listSessions();
    if (!Array.isArray(records)) records = [];
    records = records
      .filter((record) => record?.header && record.header.origin !== 'subagent')
      .slice(0, MAX_SESSIONS);

    const ids = records.map((record) => String(record.header.id));
    let titles = new Map();
    if (ids.length > 0 && typeof readTitleSnapshots === 'function') {
      try {
        const observations = await readTitleSnapshots(ids);
        for (const observation of observations ?? []) {
          if (observation?.status === 'fulfilled' && observation.value?.title?.title) {
            titles.set(String(observation.sessionId), observation.value.title.title);
          }
        }
      } catch {
        titles = new Map();
      }
    }

    const sessions = records.map((record) => ({
      sessionId: String(record.header.id),
      title: titles.get(String(record.header.id)) ?? null,
      createdAt: typeof record.header.createdAt === 'number' ? record.header.createdAt : null,
      live: record.live === true,
      persisted: record.persisted === true,
    }));

    writeJson(response, 200, { sessions });
  }, admitRequest);
}

export function createTurnsHandler({ readSession, trustedHosts = [], onError = () => {}, admitRequest }) {
  return (request, response) => handle(request, response, trustedHosts, onError, async () => {
    const value = await readJsonBody(request);
    const sessionId = sessionIdOf(value);
    const snapshot = canonicalSnapshot(sessionId, await readSession(sessionId));
    const { entries } = extractConversation(snapshot.events, {
      includeReasoning: false,
      includeTools: false,
      metadataOnly: true,
      maxTextChars: 400,
    });
    const turns = entries.map((entry, index) => ({
      index,
      human: shortPreview(entry.humans.join(' / ')),
      assistant: entry.assistant === null ? null : shortPreview(entry.assistant),
      hasReasoning: entry.hasReasoning === true,
      hasTools: entry.hasTools === true,
    }));
    writeJson(response, 200, { turns });
  }, admitRequest);
}

export function createBuildHandler({ readSession, trustedHosts = [], onError = () => {}, admitRequest }) {
  return (request, response) => handle(request, response, trustedHosts, onError, async () => {
    const value = await readJsonBody(request);
    const sessionId = sessionIdOf(value);
    const includeReasoning = value.includeReasoning === true;
    const includeTools = value.includeTools === true;
    const ignoreQuestions = value.ignoreQuestions === true;
    const lang = value.lang === 'zh' ? 'zh' : 'en';
    const requestedFormat = value.format === 'md' || value.format === 'html' || value.format === 'pdf'
      ? value.format
      : 'all';
    const snapshot = canonicalSnapshot(sessionId, await readSession(sessionId));
    const { title, entries, stats } = extractConversation(snapshot.events, { includeReasoning, includeTools });
    let selected = selectEntries(entries, value.selection);
    if (ignoreQuestions) {
      selected = selected.map((entry) => ({ ...entry, humans: [] }));
    }
    const payload = {
      sessionId,
      title: title ?? null,
      fileStem: fileStem(sessionId, title),
      stats,
    };
    if (requestedFormat === 'all' || requestedFormat === 'md') {
      payload.markdown = renderMarkdown(selected, title, { lang });
    }
    if (requestedFormat === 'all' || requestedFormat === 'html') {
      payload.html = renderHtmlDocument(selected, title, { lang });
    }
    if (requestedFormat === 'all' || requestedFormat === 'pdf') {
      payload.fragment = renderHtmlFragment(selected, title, { lang });
    }
    writeJson(response, 200, payload);
  }, admitRequest);
}
