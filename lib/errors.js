/**
 * One API error carrying a stable machine code the Client maps to a message.
 * The codes mirror the ones Reasonix Studio exposes for prompt refinement:
 * empty / too_long / no_model / timeout / no_answer / failed / bad_request.
 */
export class ApiError extends Error {
  /**
   * @param {string} code stable machine code.
   * @param {string} [message] optional diagnostic detail (never user-facing).
   */
  constructor(code, message) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
  }
}

/** True when the value is an ApiError produced by this plugin. */
export function isApiError(value) {
  return value instanceof ApiError;
}
