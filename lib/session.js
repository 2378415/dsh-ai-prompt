/**
 * Session-log reads used by the refinement endpoint.
 *
 * The read is read-only: refinement derives conversation context and the model
 * route. The plugin never appends events, never edits a log, and never deletes
 * a session.
 */
import { ApiError } from './errors.js';

/**
 * Read one complete session log (live or persisted).
 * @param {any} ctx host context.
 * @param {string} sessionId durable session identity.
 * @returns {Promise<{session: any, events: any[]}>} the replay-validated log.
 * @throws {ApiError} when no session-query service or the session cannot be read.
 */
export async function readLog(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new ApiError('bad_request', 'sessionId is required');
  }
  const sessionQuery = ctx.get('sessionQuery');
  if (sessionQuery === undefined || typeof sessionQuery.readSession !== 'function') {
    throw new ApiError('failed', 'session query service is unavailable');
  }
  let log;
  try {
    log = await sessionQuery.readSession(sessionId);
  } catch (error) {
    throw new ApiError('failed', `session read failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (log === null || typeof log !== 'object' || !Array.isArray(log.events)) {
    throw new ApiError('failed', 'session log is unavailable');
  }
  return log;
}

/** The session working directory when the header carries one. */
export function cwdOf(log) {
  const value = log && log.session && log.session.cwd;
  return typeof value === 'string' ? value : '';
}

/**
 * Resolve the provider/model route the session itself last used.
 *
 * `request/context` and `request/header` are written per call, so the latest
 * one is exactly the route the user selected in this session. The profile's
 * default selection is only a fallback for a session that never called a model.
 * @param {any} ctx host context.
 * @param {readonly any[]} events session events.
 * @returns {{provider: string, model: string} | null} the route, when known.
 */
export function resolveRoute(ctx, events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || typeof event.type !== 'string') continue;
    if (event.type === 'request/context') {
      const data = event.data || {};
      if (typeof data.provider === 'string' && data.provider !== '' && typeof data.model === 'string' && data.model !== '') {
        return { provider: data.provider, model: data.model };
      }
    }
    if (event.type === 'request/header') {
      const config = event.data && event.data.header && event.data.header.config;
      if (config && typeof config.provider === 'string' && config.provider !== '' && typeof config.model === 'string' && config.model !== '') {
        return { provider: config.provider, model: config.model };
      }
    }
  }
  const defaults = ctx.get('agentDefaultModel');
  if (defaults !== undefined && typeof defaults.currentSelection === 'function') {
    try {
      const selection = defaults.currentSelection();
      if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string'
        && selection.provider !== '' && selection.model !== '') {
        return { provider: selection.provider, model: selection.model };
      }
    } catch {
      // A missing default is reported by the caller as no_model.
    }
  }
  return null;
}
