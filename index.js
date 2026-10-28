/**
 * dsh-ai-prompt — Host half.
 *
 * One read-only operation behind one same-origin API:
 *   `POST /refine`  rewrite the composer draft with the session's own model,
 *                   using the conversation around that draft.
 *
 * The Client half owns every visual surface. This plugin never edits or deletes
 * a durable session log.
 *
 * Optional capabilities are looked up softly at request time: no model service,
 * no session query, or no default model removes one answer instead of failing
 * the row.
 */
import { readConfig } from './lib/config.js';
import { registerRoutes } from './lib/routes.js';

export const name = 'ai-prompt';
export const inject = ['webServer'];

/**
 * Activate the HTTP surface.
 * @param {any} ctx host context.
 * @param {unknown} config the Loader row's raw config object.
 */
export function apply(ctx, config) {
  const settings = readConfig(config);
  ctx.effect(() => registerRoutes(ctx, settings), 'ai-prompt: routes');
}
