/**
 * Prompt assembly for one refinement request.
 *
 * The model receives the rewrite rules as the system prompt and one user
 * message that separates the conversation context, the working directory and
 * the draft with XML-ish tags, so a draft that itself contains Markdown or
 * instructions cannot leak into the surrounding sections.
 */

/**
 * Build the single user message body.
 * @param {string} draft current composer text.
 * @param {{ text: string, used: number }} context conversation context.
 * @param {string} [cwd] session working directory.
 * @returns {string} the user message text.
 */
export function buildInput(draft, context, cwd) {
  const parts = [];
  if (context.text.trim() !== '') {
    parts.push(`<conversation_context>\n${context.text}\n</conversation_context>`);
  }
  if (typeof cwd === 'string' && cwd.trim() !== '') {
    parts.push(`<cwd>${cwd.trim()}</cwd>`);
  }
  parts.push(`<draft>\n${draft}\n</draft>`);
  parts.push('Rewrite the draft now.');
  return parts.join('\n\n');
}

/**
 * Remove wrappers a model occasionally adds despite the instruction.
 * @param {string} raw accumulated stream text.
 * @returns {string} the prompt as it should land in the composer.
 */
export function sanitizeResult(raw) {
  let text = String(raw || '').trim();
  if (text === '') return '';

  // A single fenced block around the whole answer: keep its contents.
  const fenced = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/u.exec(text);
  if (fenced !== null) text = fenced[1].trim();

  // A labelled answer such as "Rewritten prompt: ..." or "优化后的提示词：...".
  const labelled = /^(?:rewritten\s+prompt|refined\s+prompt|optimized\s+prompt|优化后的提示词|优化结果|改写后的提示词)\s*[:：]\s*/iu.exec(text);
  if (labelled !== null) text = text.slice(labelled[0].length).trim();

  // Straight quotes wrapped around the entire answer.
  const quoted = /^(["“])([\s\S]*)(["”])$/u.exec(text);
  if (quoted !== null && !text.includes('\n')) text = quoted[2].trim();

  return text.trim();
}
