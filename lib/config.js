/**
 * Effective runtime configuration.
 *
 * The bundle declares no `Config` export on purpose: that would require the
 * `@deepseek-ai/schemastery` package at runtime, which a linked bundle cannot
 * resolve from the DSH installation. The Loader still passes the row's raw
 * `config` object through, so every tunable is normalized here with defaults.
 */

/** Built-in rewrite instruction; replaceable through `config.systemPrompt`. */
export const DEFAULT_SYSTEM_PROMPT = [
  'You are a prompt editor inside a coding assistant. Rewrite the user\'s draft prompt so it is',
  'clearer, more specific, and easier for an autonomous coding agent to execute. Use the supplied',
  'conversation context only to resolve references such as "this file", "the error above" or "again".',
  'Rules:',
  '- Preserve the user\'s intent, language and every concrete identifier (paths, commands, versions,',
  '  error text, code, @file mentions, slash commands).',
  '- Do not invent requirements, constraints, APIs, files or facts that are absent from the draft and',
  '  the context; do not add placeholders the draft did not already have.',
  '- Keep it about the same length or shorter. Prefer a compact structure (goal, context, constraints,',
  '  expected result) only when it helps the agent.',
  '- Keep Markdown and code fences intact. If the draft is already clear, make only minor edits.',
  '- Output only the rewritten prompt: no preamble, no explanation, no surrounding quotes.',
].join('\n');

/** Defaults for every tunable; the patch config overrides them. */
export const DEFAULTS = {
  maxDraftChars: 8000,
  historyMessages: 6,
  historyChars: 4000,
  messageChars: 700,
  timeoutMs: 45000,
  maxOutputTokens: 8192,
  includeContext: true,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

/** Clamp one integer option. */
function integer(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

/**
 * Normalize the Loader row config into the effective settings.
 * @param {unknown} raw untrusted row config.
 * @returns {typeof DEFAULTS} a complete, detached settings object.
 */
export function readConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const systemPrompt = typeof source.systemPrompt === 'string' && source.systemPrompt.trim() !== ''
    ? source.systemPrompt
    : DEFAULTS.systemPrompt;
  return {
    maxDraftChars: integer(source.maxDraftChars, DEFAULTS.maxDraftChars, 200, 60000),
    historyMessages: integer(source.historyMessages, DEFAULTS.historyMessages, 0, 24),
    historyChars: integer(source.historyChars, DEFAULTS.historyChars, 0, 20000),
    messageChars: integer(source.messageChars, DEFAULTS.messageChars, 100, 4000),
    timeoutMs: integer(source.timeoutMs, DEFAULTS.timeoutMs, 5000, 180000),
    maxOutputTokens: integer(source.maxOutputTokens, DEFAULTS.maxOutputTokens, 128, 8192),
    includeContext: source.includeContext === false ? false : DEFAULTS.includeContext,
    systemPrompt,
  };
}
