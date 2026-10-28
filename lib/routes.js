/**
 * HTTP surface of the plugin, under `/dsh-ai-prompt/api`.
 *
 * Every route runs the Host's own trust gate first (`ctx.connection
 * .requestRejection`: its Host/Origin fence plus the browser login the page
 * already carries). A host without that service falls back to a loopback +
 * same-origin fence, which is what a plain `dsh web` deployment needs.
 *
 * Responses carry prompts, status and error codes only; credentials never
 * travel through this API.
 */
import { ApiError } from './errors.js';
import { refinePrompt } from './refine.js';

const PREFIX = '/dsh-ai-prompt/api';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_BODY_BYTES = 256 * 1024;

/** Write one JSON response unless the connection is already gone. */
function sendJson(response, status, body) {
  if (response.writableEnded || response.destroyed) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

/** Loopback + same-origin fence used when the trust service is absent. */
function loopbackFence(request) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return 403;
  const host = String(request.headers.host || '');
  if (!host) return undefined;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return LOOPBACK.has(name.toLowerCase()) ? undefined : 403;
}

/** Host trust gate, when the connection service is mounted. */
function rejectionOf(ctx, request) {
  const connection = ctx.get('connection');
  if (connection && typeof connection.requestRejection === 'function') {
    try {
      return connection.requestRejection(request) ?? undefined;
    } catch {
      return 403;
    }
  }
  return loopbackFence(request);
}

/** Read a bounded JSON body. */
function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError('bad_request', 'body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch {
        reject(new ApiError('bad_request', 'invalid JSON body'));
      }
    });
    request.on('error', reject);
  });
}

/** Best-effort warning through the Host logger. */
function warn(ctx, message) {
  try {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('ai-prompt') : ctx.logger;
    if (logger && typeof logger.warn === 'function') logger.warn(message);
  } catch {
    // Logging is a nicety, never a dependency.
  }
}

/** Map one thrown value onto the wire error envelope. */
function failure(response, error, fallbackCode) {
  const code = error instanceof ApiError ? error.code : fallbackCode;
  const message = error instanceof Error ? error.message : String(error);
  sendJson(response, 200, { ok: false, error: { code, message } });
}

/**
 * Register every route; returns one disposer for the whole surface.
 * @param {any} ctx host context carrying `webServer`.
 * @param {import('./config.js').DEFAULTS} settings effective settings.
 */
export function registerRoutes(ctx, settings) {
  /** One in-flight refinement per session; a newer request supersedes it. */
  const inflight = new Map();

  const guarded = (handler) => (request, response) => {
    const status = rejectionOf(ctx, request);
    if (status !== undefined) {
      sendJson(response, status, {
        ok: false,
        error: { code: status === 401 ? 'login_required' : 'untrusted_request', message: 'request rejected' },
      });
      return;
    }
    try {
      Promise.resolve(handler(request, response)).catch((error) => failure(response, error, 'failed'));
    } catch (error) {
      failure(response, error, 'failed');
    }
  };

  const health = guarded((request, response) => {
    if (request.method !== 'GET') {
      sendJson(response, 405, { ok: false, error: { code: 'method_not_allowed', message: 'GET required' } });
      return;
    }
    sendJson(response, 200, { ok: true, version: '0.1.0', limits: {
      maxDraftChars: settings.maxDraftChars,
      timeoutMs: settings.timeoutMs,
    } });
  });

  const refine = guarded(async (request, response) => {
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: { code: 'method_not_allowed', message: 'POST required' } });
      return;
    }
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      failure(response, error, 'bad_request');
      return;
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (sessionId === '') {
      sendJson(response, 200, { ok: false, error: { code: 'bad_request', message: 'sessionId is required' } });
      return;
    }

    const previous = inflight.get(sessionId);
    if (previous !== undefined) {
      try {
        previous.abort();
      } catch {
        // Already settled.
      }
    }
    const controller = new AbortController();
    inflight.set(sessionId, controller);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, settings.timeoutMs);
    const onClose = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.on('close', onClose);

    try {
      const result = await refinePrompt(ctx, settings, {
        sessionId,
        draft: typeof body.draft === 'string' ? body.draft : '',
        signal: controller.signal,
      });
      sendJson(response, 200, {
        ok: true,
        text: result.text,
        used: result.used,
        provider: result.provider,
        model: result.model,
      });
    } catch (error) {
      if (timedOut) failure(response, new ApiError('timeout'), 'timeout');
      else failure(response, error, 'failed');
    } finally {
      clearTimeout(timer);
      response.off('close', onClose);
      if (inflight.get(sessionId) === controller) inflight.delete(sessionId);
    }
  });

  const routes = [
    { path: `${PREFIX}/health`, handler: health },
    { path: `${PREFIX}/refine`, handler: refine },
  ];

  const disposers = [];
  for (const route of routes) {
    try {
      disposers.push(ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }));
    } catch (error) {
      warn(ctx, `route ${route.path} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return () => {
    for (const controller of inflight.values()) {
      try {
        controller.abort();
      } catch {
        // Already settled.
      }
    }
    inflight.clear();
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // Gone with the server.
      }
    }
  };
}
