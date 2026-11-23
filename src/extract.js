/**
 * Extract the clean conversation from raw session events.
 *
 * Deterministic rules:
 *  1. A human turn is a turn bracket containing at least one append-origin
 *     `user/message` whose `source.kind === 'user'`. Plugin/goal/skill
 *     injections and injection-only turns are excluded.
 *  2. The final assistant response of a turn is the last append-origin
 *     `assistant/message` with non-empty visible text. Intermediate steps never
 *     render as the answer.
 *  3. Only `text` content blocks render verbatim. `reasoning` blocks are kept
 *     separately and rendered only when `includeReasoning` is true. `tool-call`
 *     blocks and `tool/result` events are kept separately and rendered only when
 *     `includeTools` is true.
 *  4. A human message with no visible text (e.g. image-only) renders the neutral
 *     placeholder `[Image omitted]`.
 *  5. A turn without a final assistant response renders no assistant section.
 *  6. Replacement-origin surface events (compaction) are model-only shadowing and
 *     are skipped; append-origin events are the durable transcript source.
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

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
    unknownBlocks: 0,
    unknownEvents: 0,
  };
}

/** Join the visible text blocks of a message, collecting reasoning and tool calls. */
function analyzeContent(content, stats, sink) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== 'string') {
      stats.unknownBlocks++;
      continue;
    }
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text.trim() !== '') parts.push(block.text);
    } else if (block.type === 'reasoning') {
      stats.reasoningBlocks++;
      if (typeof block.text === 'string' && block.text.trim() !== '') {
        (sink.reasoning ??= []).push(block.text);
      }
    } else if (block.type === 'tool-call') {
      stats.toolCallBlocks++;
      if (isRecord(sink) && typeof block.name === 'string') {
        (sink.toolCalls ??= []).push({
          id: typeof block.id === 'string' ? block.id : '',
          name: block.name,
          arguments: typeof block.arguments === 'string' ? block.arguments : '',
        });
      }
    } else if (block.type === 'tool-result') {
      stats.toolResultBlocks++;
    } else if (block.type === 'image') {
      stats.imageBlocks++;
    } else {
      stats.unknownBlocks++;
    }
  }
  return parts.join('\n\n');
}

function truncateText(value, max) {
  if (typeof value !== 'string') return '';
  const characters = Array.from(value);
  if (characters.length <= max) return value;
  return `${characters.slice(0, max).join('')}\n… (${characters.length - max} more characters)`;
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

  const stats = createStats();
  const turns = [];
  let current = null;
  let title = null;

  for (const event of events) {
    const type = event?.type;

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
        throw new Error(`unrecognized surface event type "${type}" (seq ${event.seq})`);
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
        if (isRecord(message?.source) && message.source.kind === 'user') {
          current.humanCount++;
          const text = analyzeContent(message.content, stats, {});
          current.humans.push(text.trim() !== '' ? text : IMAGE_OMITTED_PLACEHOLDER);
          stats.humanMessages++;
        } else {
          stats.injectedUserMessages++;
        }
      } else if (type === 'assistant/message') {
        stats.assistantMessages++;
        const sink = { reasoning: [], toolCalls: [] };
        const text = analyzeContent(event.data?.message?.content, stats, sink);
        if (sink.toolCalls.length > 0) {
          stats.toolCalls += sink.toolCalls.length;
          current.toolCalls.push(...sink.toolCalls);
        }
        current.assistants.push({
          seq: event.seq,
          time: typeof event.time === 'number' ? event.time : null,
          text,
          reasoning: sink.reasoning.join('\n\n'),
        });
      } else if (type === 'tool/result') {
        stats.toolResults++;
        const message = event.data?.message;
        const callId = typeof message?.toolCallId === 'string' ? message.toolCallId : '';
        let resultText = '';
        if (Array.isArray(message?.content)) {
          const parts = [];
          for (const block of message.content) {
            if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
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

    if (KNOWN_LOG_ONLY_TYPES.has(type)) continue;
    stats.unknownEvents++;
  }

  const entries = [];
  for (const turn of turns) {
    if (turn.humanCount === 0) continue;
    stats.humanTurns++;

    const answer = [...turn.assistants].reverse().find((item) => item.text.trim() !== '');
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
