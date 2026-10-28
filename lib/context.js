/**
 * Conversation-context assembly for one refinement request.
 *
 * Only surface text is used: user prompts and assistant answers. Tool calls,
 * tool results, system/developer messages and reasoning blocks are dropped both
 * for size and for privacy, so the rewrite sees the same conversation a person
 * would scroll through.
 */

/** Join the text blocks of one content array. */
export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text;
  }
  return out;
}

/** Collapse whitespace for draft-to-history matching. */
export function normalize(text) {
  return String(text || '').replace(/\s+/gu, ' ').trim();
}

/** Cut a long message on a word boundary where possible. */
export function clip(text, max) {
  const value = String(text || '').trim();
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Collect the ordered conversation messages of one session log.
 * @param {readonly any[]} events session events in ascending seq order.
 * @returns {{role: 'user' | 'assistant', text: string}[]} text messages only.
 */
export function collectMessages(events) {
  const messages = [];
  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue;
    if (event.type === 'user/message') {
      const text = textOf(event.data && event.data.content).trim();
      if (text !== '') messages.push({ role: 'user', text });
      continue;
    }
    if (event.type === 'assistant/message') {
      const message = event.data && event.data.message;
      const text = textOf(message && message.content).trim();
      if (text !== '') messages.push({ role: 'assistant', text });
    }
  }
  return messages;
}

/**
 * Index of the earlier user message this draft repeats, if any.
 *
 * A draft that is being re-sent is usually an edit of an earlier prompt, and
 * anchoring the history around exactly that message is what makes the rewrite
 * resolve "this", "again" and "the same as before" the way Reasonix does.
 * @param {{role: string, text: string}[]} messages ordered conversation text.
 * @param {string} draft current composer draft.
 * @returns {number} zero-based message index, or -1 when the draft is new.
 */
export function locateDraft(messages, draft) {
  const needle = normalize(draft);
  if (needle === '') return -1;
  let partial = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    const value = normalize(message.text);
    if (value === needle) return index;
    if (partial < 0 && needle.length >= 8 && (value.includes(needle) || needle.includes(value))) {
      partial = index;
    }
  }
  return partial;
}

/**
 * Build the context block handed to the model.
 * @param {{role: string, text: string}[]} messages full conversation text.
 * @param {number} anchor located draft index, or -1.
 * @param {{historyMessages: number, historyChars: number, messageChars: number}} settings limits.
 * @returns {{ text: string, used: number }} context text and message count used.
 */
export function buildContext(messages, anchor, settings) {
  const limit = Math.max(0, settings.historyMessages);
  if (limit === 0 || messages.length === 0) return { text: '', used: 0 };

  let start = Math.max(0, messages.length - limit);
  if (anchor >= 0) {
    // Keep the anchored message inside the window with a few messages on both
    // sides, the way "History around message N" is meant to read.
    const half = Math.max(1, Math.floor(limit / 2));
    start = Math.max(0, Math.min(anchor - half, messages.length - limit));
  }
  let end = Math.min(messages.length, start + limit);
  if (anchor >= start && anchor >= end) end = Math.min(messages.length, anchor + 1);
  if (start >= end) {
    start = Math.max(0, end - limit);
  }

  const selected = messages.slice(start, end);
  const lines = [];
  let budget = settings.historyChars;
  let used = 0;
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const message = selected[index];
    const text = clip(message.text, settings.messageChars);
    const cost = text.length + message.role.length + 8;
    if (budget - cost < 0) break;
    budget -= cost;
    used += 1;
    lines.unshift(`[${start + index}] ${message.role}: ${text}${anchor === start + index ? '\n    <<< the draft below repeats this message' : ''}`);
  }
  return { text: lines.join('\n'), used };
}
