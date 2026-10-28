/**
 * One context-aware rewrite: read the session, assemble the context window,
 * resolve the route the session last used, stream one model call, and return
 * the sanitized prompt text.
 *
 * The call is an auxiliary, side-channel request: it is not appended to the
 * session log and does not enter the conversation. That matches how Reasonix
 * Studio's "Refine prompt" behaves and keeps the durable log untouched.
 */
import { ApiError } from './errors.js';
import { buildContext, collectMessages, locateDraft } from './context.js';
import { buildInput, sanitizeResult } from './prompt.js';
import { cwdOf, readLog, resolveRoute } from './session.js';

/**
 * Output budget for one rewrite.
 *
 * A rewrite is roughly as long as the draft, and tokenizers spend about one
 * token per CJK character (fewer for Latin text). The budget therefore scales
 * with the draft instead of using one fixed cap, which used to cut long drafts
 * in half. `cap` is the configured ceiling.
 * @param {number} draftLength draft length in characters.
 * @param {number} cap configured maximum output tokens.
 * @returns {number} tokens to request for this draft.
 */
export function outputBudget(draftLength, cap) {
  const ceiling = Number.isFinite(cap) && cap > 0 ? Math.trunc(cap) : 8192;
  const wanted = Math.ceil(Math.max(0, draftLength) * 0.9) + 256;
  const floor = Math.min(1024, ceiling);
  return Math.max(floor, Math.min(ceiling, wanted));
}

/**
 * Resolve the largest output budget the exact model route can accept.
 *
 * The configured ceiling is only an upper bound: a model may advertise a
 * smaller `defaultMaxTokens`, and asking for more than that would fail the
 * whole request instead of producing a shorter rewrite.
 * @param {any} llm the llm service.
 * @param {{provider: string, model: string}} route exact model route.
 * @param {number} ceiling configured upper bound.
 * @param {AbortSignal | undefined} signal caller cancellation.
 * @returns {Promise<number>} the usable ceiling.
 */
async function resolvedCeiling(llm, route, ceiling, signal) {
  if (typeof llm.resolveModelInfo !== 'function') return ceiling;
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model, signal);
    const modelCap = Number(info && info.defaultMaxTokens);
    if (Number.isFinite(modelCap) && modelCap > 0) return Math.min(ceiling, modelCap);
  } catch {
    // Capability lookup is advisory; the configured ceiling still applies.
  }
  return ceiling;
}

/**
 * Run one refinement.
 * @param {any} ctx host context.
 * @param {import('./config.js').DEFAULTS} settings effective settings.
 * @param {{sessionId: string, draft: string, signal?: AbortSignal}} request caller input.
 * @returns {Promise<{text: string, used: number, provider: string, model: string}>} result.
 * @throws {ApiError} with a machine code the Client maps to localized text.
 */
export async function refinePrompt(ctx, settings, request) {
  const draft = typeof request.draft === 'string' ? request.draft : '';
  if (draft.trim() === '') throw new ApiError('empty');
  if (draft.length > settings.maxDraftChars) {
    throw new ApiError('too_long', `draft is ${draft.length} characters`);
  }
  if (request.signal && request.signal.aborted) throw new ApiError('timeout');

  const log = await readLog(ctx, request.sessionId);
  const messages = collectMessages(log.events);
  const anchor = locateDraft(messages, draft);
  const context = settings.includeContext
    ? buildContext(messages, anchor, settings)
    : { text: '', used: 0 };

  const route = resolveRoute(ctx, log.events);
  if (route === null) throw new ApiError('no_model', 'no model route is available for this session');

  const llm = ctx.get('llm');
  if (llm === undefined || typeof llm.stream !== 'function') {
    throw new ApiError('no_model', 'the llm service is unavailable');
  }

  const input = buildInput(draft, context, cwdOf(log));
  const ceiling = await resolvedCeiling(llm, route, settings.maxOutputTokens, request.signal);
  const maxTokens = outputBudget(draft.length, ceiling);
  let raw = '';
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: settings.systemPrompt,
      messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
      maxTokens,
      signal: request.signal,
    });
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        raw += chunk.text;
        continue;
      }
      if (chunk.type === 'finish') {
        const reason = chunk.reason || {};
        if (reason.kind === 'error') {
          throw new ApiError('failed', reason.failure && reason.failure.message ? reason.failure.message : 'model request failed');
        }
        if (reason.kind === 'aborted') {
          throw new ApiError('timeout', reason.failure && reason.failure.message ? reason.failure.message : 'model request aborted');
        }
        if (reason.kind === 'max-tokens') {
          throw new ApiError('output_limit', 'the rewrite reached the output token limit');
        }
      }
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (request.signal && request.signal.aborted) throw new ApiError('timeout');
    const message = error instanceof Error ? error.message : String(error);
    if (/abort/iu.test(message)) throw new ApiError('timeout');
    throw new ApiError('failed', message);
  }

  const text = sanitizeResult(raw);
  if (text === '') throw new ApiError('no_answer');
  return { text, used: context.used, provider: route.provider, model: route.model };
}
