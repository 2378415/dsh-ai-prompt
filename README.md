# dsh-ai-prompt

A DeepSeek Harness plugin that adds **context-aware prompt refinement** to the
conversation composer.

- **✦ trigger** sits in the composer tool row, right after the permission
  control (`conversation.input.left`).
- **Dialog** rewrites the current draft with the session's own model, using the
  messages around that draft. Your text is untouched until you press **Adopt**.
- **Adopt** replaces the composer draft; a dock notice offers a one-click undo.

Nothing durable is edited: the plugin never writes to a session log, never
changes a conversation, and never deletes a session.

## Install

```
plugin_manager install_bundle <absolute path to this directory>
```

The bundle inserts one Host row (`ai-prompt`) and serves two same-origin
routes. No build step, no runtime dependencies.

## Use

| Action | Result |
|---|---|
| Click ✦ with a draft | Dialog opens and refinement starts immediately |
| **Adopt** | Replaces the composer draft; a dock notice offers **Undo** |
| **Try again** | Repeats the rewrite for the same draft |
| **Discard** / `Esc` | Closes the dialog and keeps your original text |

Keyboard: `Esc` closes, `Ctrl/Cmd+Enter` adopts.

## API

All routes live under `/dsh-ai-prompt/api` and pass the Host trust gate
(`ctx.connection.requestRejection`, with a loopback/same-origin fallback).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness plus effective limits |
| `POST` | `/refine` | `{sessionId, draft}` → `{text, used, provider, model}` |

Failures use `{ ok: false, error: { code, message } }` with the codes
`empty`, `too_long`, `no_model`, `timeout`, `no_answer`, `output_limit`,
`failed`, `bad_request`.

## Configuration

The Loader row accepts these fields (defaults shown):

```yaml
- id: ai-prompt
  name: dsh-ai-prompt
  config:
    maxDraftChars: 8000
    historyMessages: 6
    historyChars: 4000
    messageChars: 700
    timeoutMs: 45000
    maxOutputTokens: 8192
    includeContext: true
    systemPrompt: <built-in rewrite instruction>
```

`maxOutputTokens` is a ceiling, not a fixed request: the plugin asks for
`ceil(draft.length * 0.9) + 256` tokens (at least 1024, at most the ceiling), so
a long draft is not cut in half. If the model still stops at that limit the
request fails with `output_limit` instead of returning a truncated prompt.

## Limits

- The rewrite is an auxiliary model call: it is not written to the session log
  and not counted in the session's token usage.
- The dialog previews plain text; adopting it replaces the composer draft and
  may drop resolved `@file` chips from the text (the text itself is preserved).
- The selected model is the route the session last used; a session that never
  called a model falls back to the profile default.

## Tests

Dependency-free checks that run on Node 22+ (`node --check` plus these):

```
node test/context.test.mjs   # context window, draft matching, prompt assembly
node test/routes.test.mjs    # real HTTP over the registered route handlers
node test/client.test.mjs    # seats, dialog and adopt flow headless
```
