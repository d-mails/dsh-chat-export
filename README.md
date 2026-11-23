# DSH Chat Export

English | [简体中文](README.zh.md)

Export the current conversation — or any historical session — to **Markdown / HTML / PDF**. Everything runs locally in your browser; nothing is uploaded.

## Features

- **Pick any conversation**: the “Export chat” button in the session header opens a dialog; it defaults to the current session and lets you choose any other session from a dropdown.
- **Three formats**: Markdown, HTML (a self-contained styled page), and PDF (rasterized in the browser, CJK-friendly, no print dialog).
- **Thinking optional**: reasoning is skipped by default; enable “Include thinking” to export it in collapsible blocks.
- **Tool calls optional**: tool calls and results are skipped by default; enable “Include tool calls” to export each call’s arguments and result (long results are truncated).
- **Turn selection**: lists every Q&A turn, all selected by default; tick/untick individual turns or select all/clear.
- **Ignore the questioner**: option to export only assistant replies, dropping user prompts (composable with thinking/tools).
- **Local-only security**: the plugin reads `sessionQuery` through same-origin host routes; data moves only between the local host process and the local browser.

## Install

Requires DeepSeek Harness Web (desktop app or `dsh web`) and Node.js ≥ 20.

From GitHub:

```bash
dsh plugin add d-mails/dsh-chat-export --profile web
```

From a local checkout:

```bash
dsh plugin add ./dsh-chat-export --profile web
```

Restart `dsh web` (or reopen DSH) after installing; the “Export chat” button appears at the right of the session header.

## Usage

1. Open any conversation and click **Export chat** in the header.
2. Choose the conversation and format; toggle “Include thinking”, “Include tool calls” and “Ignore questioner content” as needed.
3. Untick the turns you do not want (all are selected by default).
4. Click **Export**; the browser downloads `<title>--<short-session-id>.<md|html|pdf>`.

## Compatibility

- Developed and verified on `@deepseek-ai/dsh@0.2.2-rc.3` (Web).
- DSH evolves quickly and plugin APIs may change. If the plugin breaks after a DSH upgrade, check the current `sessionQuery` / `webServer` contracts.

## Notes and limitations

- PDF export rasterizes the exported HTML into a multi-page PDF of **full-page images**. Page breaks are chosen inside whitespace bands of the real rendering, so text lines are never cut. Because pages are images, PDF text is **not selectable/searchable** and files are larger; generation time grows with conversation length (long chats can be dozens of pages), and there is currently no progress bar or cancel.
- If the environment cannot generate the PDF directly (or the conversation is too long), it opens a print view so you can “Save as PDF”, and keeps an HTML fallback download.
- Only human messages and each turn’s final assistant reply are exported; intermediate assistant steps are not separate sections (their thinking/tool calls are folded into the turn when those options are enabled).
- Image messages are represented as placeholder text; images are not embedded. The Markdown converter does not support math, deeply nested lists, or other advanced syntax.
- The session list shows at most 300 sessions and excludes subagent sessions.
- “Ignore questioner content” is a global toggle, not a per-turn option.

## Privacy

Export is fully local: the plugin makes no network calls, writes no remote storage, and has no telemetry. Conversation content moves only between the local host process and the local browser that requested it.

## Development

Zero runtime dependencies, pure ESM. Host code lives in `index.js` and `src/`; the browser half is `client.js`.

```bash
node --test test/core.test.js test/client.test.js test/handlers.test.js
```

## License

[MIT](LICENSE)
