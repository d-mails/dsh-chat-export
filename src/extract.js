/**
 * Extract the clean conversation from raw session events.
 *
 * Deterministic rules:
 *  1. A human turn is a turn bracket containing at least one append-origin
 *     `user/message` whose `source.kind` is `user` or `goal`. Plugin/skill
 *     injections and injection-only turns are excluded.
 *  2. The final assistant response of a turn is the last append-origin
 *     `assistant/message` with non-empty visible text, only when no tool call
 *     follows it in the turn. Intermediate steps never render as the answer.
 *  3. Only `text` content blocks render verbatim. `reasoning` blocks are kept
 *     separately and rendered only when `includeReasoning` is true. `tool-call`
 *     blocks and `tool/result` events are kept separately and rendered only when
 *     `includeTools` is true.
 *  4. A human message with no visible text (e.g. image-only) renders the neutral
 *     placeholder `[Image omitted]`.
 *  5. A turn without a final assistant response renders no assistant section.
 *  6. A `dsh-rewind` replacement hides the append-origin messages it covers.
 *     Compaction replacements are model-only shadowing and leave the durable
 *     transcript intact.
 *  7. The latest usable log-only `session/title` wins.
 */

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);

const KNOWN_LOG_ONLY_TYPES = new Set([
  'step/start',
  'step/end',
  'assistant/chunk',
  'tool/call',
  'todo/write',
  'request/header',
  'request/context',
  'session/end-seed',
]);

const UNSAFE_TITLE_CHARACTER = /[\u0000-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/u;

const IMAGE_OMITTED_PLACEHOLDER = '[Image omitted]';
const HUMAN_SOURCE_KINDS = new Set(['user', 'goal']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Collect the append-origin ranges hidden by explicit user rewinds. */
function collectRewindRanges(events) {
  const ranges = [];
  for (const event of events) {
    const operation = event?.surfaceOp;
    if (event?.type !== 'user/message'
      || !isRecord(operation)
      || operation.op !== 'replace'
      || event.data?.source?.kind !== 'dsh-rewind') continue;
    const start = operation.startSeq;
    const end = operation.endSeq;
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end) {
      ranges.push({ start, end });
    }
  }
  return ranges;
}

function isRewound(seq, ranges) {
  if (!Number.isSafeInteger(seq)) return false;
  return ranges.some((range) => seq >= range.start && seq <= range.end);
}

function createStats() {
  return {
    turns: 0,
    humanTurns: 0,
    humanMessages: 0,
    injectedUserMessages: 0,
    assistantMessages: 0,
    finalAssistants: 0,
    toolResults: 0,
    toolCalls: 0,
    replacements: 0,
    reasoningBlocks: 0,
    toolCallBlocks: 0,
    toolResultBlocks: 0,
    imageBlocks: 0,
    fileBlocks: 0,
    unknownBlocks: 0,
    unknownEvents: 0,
  };
}

function attachmentLabel(block, kind) {
  const attachment = isRecord(block.attachment) ? block.attachment : {};
  const name = typeof attachment.name === 'string' ? attachment.name.trim() : '';
  const details = [];
  if (Number.isFinite(attachment.width) && Number.isFinite(attachment.height)) {
    details.push(`${attachment.width}×${attachment.height}`);
  }
  if (Number.isFinite(attachment.bytes)) details.push(`${attachment.bytes} bytes`);
  const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
  if (kind === 'image') return name === '' ? '' : `[Image: ${name}${suffix}]`;
  return name === '' ? '[File]' : `[File: ${name}${suffix}]`;
}

/** Join the visible text blocks of a message, collecting reasoning and tool calls. */
function analyzeContent(content, stats, sink, analysis = {}) {
  if (!Array.isArray(content)) return '';
  const metadataOnly = analysis.metadataOnly === true;
  const maxTextChars = Number.isSafeInteger(analysis.maxTextChars) ? Math.max(1, analysis.maxTextChars) : null;
  const parts = [];
  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== 'string') {
      stats.unknownBlocks++;
      continue;
    }
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text.trim() !== '') {
        parts.push(maxTextChars === null ? block.text : truncateText(block.text, maxTextChars));
      }
    } else if (block.type === 'reasoning') {
      stats.reasoningBlocks++;
      if (typeof block.text === 'string' && block.text.trim() !== '') {
        if (metadataOnly) sink.hasReasoning = true;
        else (sink.reasoning ??= []).push(block.text);
      }
    } else if (block.type === 'tool-call') {
      stats.toolCallBlocks++;
      if (isRecord(sink) && typeof block.name === 'string') {
        if (metadataOnly) sink.hasTools = true;
        else {
          (sink.toolCalls ??= []).push({
            id: typeof block.id === 'string' ? block.id : '',
            name: block.name,
            arguments: typeof block.arguments === 'string' ? block.arguments : '',
          });
        }
      }
    } else if (block.type === 'tool-result') {
      stats.toolResultBlocks++;
    } else if (block.type === 'image') {
      stats.imageBlocks++;
      const label = attachmentLabel(block, 'image');
      if (label !== '') parts.push(label);
    } else if (block.type === 'file') {
      stats.fileBlocks++;
      parts.push(attachmentLabel(block, 'file'));
    } else {
      stats.unknownBlocks++;
    }
  }
  return parts.join('\n\n');
}

function truncateText(value, max) {
  if (typeof value !== 'string') return '';
  // Fast path: UTF-16 length is an upper bound on code point count.
  if (value.length <= max) return value;
  let count = 0;
  let output = '';
  for (const character of value) {
    count++;
    if (count <= max) output += character;
  }
  if (count <= max) return value;
  return `${output}\n… (${count - max} more characters)`;
}

/**
 * @param {object[]} events - raw session events in seq order.
 * @param {{includeReasoning?: boolean, includeTools?: boolean, maxToolResultChars?: number}} [options]
 * @returns {{title: string|null, entries: object[], stats: object}}
 */
export function extractConversation(events, options = {}) {
  const includeReasoning = options.includeReasoning === true;
  const includeTools = options.includeTools === true;
  const maxToolResultChars = Number.isSafeInteger(options.maxToolResultChars)
    ? Math.max(200, options.maxToolResultChars)
    : 4000;
  const metadataOnly = options.metadataOnly === true;
  const maxTextChars = Number.isSafeInteger(options.maxTextChars) ? Math.max(1, options.maxTextChars) : null;
  const analysis = { metadataOnly, maxTextChars };

  const stats = createStats();
  const turns = [];
  const rewoundRanges = collectRewindRanges(events);
  let current = null;
  let title = null;

  for (const event of events) {
    const type = event?.type;

    // A rewind replaces a previous slice of the transcript; keep the durable
    // append history for compaction, but hide the messages explicitly undone
    // by the user.
    if (SURFACE_TYPES.has(type) && isRewound(event.seq, rewoundRanges)) continue;

    if (type === 'session/title') {
      const candidate = event.data?.title;
      if (typeof candidate === 'string' && candidate.trim() !== '' && !UNSAFE_TITLE_CHARACTER.test(candidate)) {
        title = candidate.trim();
      }
      continue;
    }

    if (type === 'turn/start') {
      if (current !== null) {
        throw new Error(`turn/start while turn ${current.turn} is still open`);
      }
      current = {
        turn: event.data?.turn,
        time: typeof event.time === 'number' ? event.time : null,
        humanCount: 0,
        humans: [],
        assistants: [],
        answerCandidate: null,
        hasReasoning: false,
        hasTools: false,
        toolCalls: [],
        toolResults: new Map(),
      };
      turns.push(current);
      stats.turns++;
      continue;
    }

    if (type === 'turn/end') {
      if (current === null) throw new Error('turn/end without an open turn');
      current = null;
      continue;
    }

    if (event?.surfaceOp !== undefined) {
      // System/developer surface messages (prompt sections, injections) are
      // never part of the readable conversation, and may appear outside any
      // turn bracket.
      if (type === 'system/message' || type === 'developer/message') continue;
      if (!SURFACE_TYPES.has(type)) {
        // New DSH releases may add surface event kinds. Do not let one unknown
        // event make the whole conversation unexportable; count it for
        // diagnostics and keep the known transcript intact.
        stats.unknownEvents++;
        continue;
      }
      if (event.surfaceOp !== 'append') {
        // Replacement copies (compaction, rewind) are model-only shadowing and
        // can sit outside a turn bracket; skip before the bracket check.
        stats.replacements++;
        continue;
      }
      if (current === null) {
        throw new Error(`surface event "${type}" (seq ${event.seq}) outside any turn bracket`);
      }
      if (type === 'user/message') {
        const message = event.data;
        if (isRecord(message?.source) && HUMAN_SOURCE_KINDS.has(message.source.kind)) {
          current.humanCount++;
          const text = analyzeContent(message.content, stats, {}, analysis);
          current.humans.push(text.trim() !== '' ? text : IMAGE_OMITTED_PLACEHOLDER);
          stats.humanMessages++;
        } else {
          stats.injectedUserMessages++;
        }
      } else if (type === 'assistant/message') {
        stats.assistantMessages++;
        const sink = { reasoning: [], toolCalls: [], hasReasoning: false, hasTools: false };
        const text = analyzeContent(event.data?.message?.content, stats, sink, analysis);
        if (sink.toolCalls.length > 0) {
          stats.toolCalls += sink.toolCalls.length;
          if (!metadataOnly) current.toolCalls.push(...sink.toolCalls);
        }
        if (sink.hasReasoning || sink.reasoning.length > 0) current.hasReasoning = true;
        if (sink.hasTools || sink.toolCalls.length > 0) current.hasTools = true;
        current.assistants.push({
          seq: event.seq,
          time: typeof event.time === 'number' ? event.time : null,
          text,
          reasoning: sink.reasoning.join('\n\n'),
        });
        if (text.trim() !== '') {
          current.answerCandidate = { text, toolCalls: sink.toolCalls.length };
        } else if (sink.toolCalls.length > 0) {
          // A tool-only step after the previous text means that text was not a
          // final reply; the turn is still in progress or ended without one.
          current.answerCandidate = null;
        }
      } else if (type === 'tool/result') {
        stats.toolResults++;
        current.answerCandidate = null;
        current.hasTools = true;
        const message = event.data?.message;
        const callId = typeof message?.toolCallId === 'string' ? message.toolCallId : '';
        let resultText = '';
        if (Array.isArray(message?.content)) {
          const parts = [];
          for (const block of message.content) {
            if (!isRecord(block)) continue;
            if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
            else if (block.type === 'image') {
              const label = attachmentLabel(block, 'image');
              if (label !== '') parts.push(label);
            } else if (block.type === 'file') {
              parts.push(attachmentLabel(block, 'file'));
            }
          }
          resultText = parts.join('\n\n');
        }
        current.toolResults.set(callId, {
          text: truncateText(resultText, maxToolResultChars),
          isError: message?.isError === true || isRecord(event.data?.error),
        });
      }
      continue;
    }

    if (type === 'tool/call') {
      // A tool call is a turn segment after the preceding assistant text; the
      // text is commentary, not the final reply.
      if (current !== null) {
        current.answerCandidate = null;
        current.hasTools = true;
      }
      continue;
    }

    if (KNOWN_LOG_ONLY_TYPES.has(type)) continue;
    stats.unknownEvents++;
  }

  const entries = [];
  for (const turn of turns) {
    if (turn.humanCount === 0) continue;
    stats.humanTurns++;

    const answer = turn.answerCandidate?.toolCalls === 0 ? turn.answerCandidate : null;
    const reasoning = includeReasoning
      ? turn.assistants.map((item) => item.reasoning).filter((value) => value.trim() !== '').join('\n\n')
      : '';

    const entry = {
      turn: turn.turn,
      time: turn.time,
      humans: turn.humans,
      assistant: answer ? answer.text : null,
      reasoning: reasoning.trim() !== '' ? reasoning : null,
      tools: [],
      hasReasoning: turn.hasReasoning,
      hasTools: turn.hasTools,
    };

    if (answer) stats.finalAssistants++;

    if (includeTools) {
      entry.tools = turn.toolCalls.map((call) => {
        const result = turn.toolResults.get(call.id);
        return {
          name: call.name,
          arguments: truncateText(call.arguments, 4000),
          result: result ? result.text : null,
          isError: result ? result.isError === true : false,
        };
      });
    }

    entries.push(entry);
  }

  return { title, entries, stats };
}
