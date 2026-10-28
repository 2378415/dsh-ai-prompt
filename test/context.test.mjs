import assert from 'node:assert/strict';
import { buildContext, collectMessages, locateDraft, textOf } from '../lib/context.js';
import { buildInput, sanitizeResult } from '../lib/prompt.js';
import { resolveRoute } from '../lib/session.js';
import { outputBudget } from '../lib/refine.js';
import { readConfig, DEFAULT_SYSTEM_PROMPT } from '../lib/config.js';

const msg = (text) => [{ type: 'text', text }];
const events = [
  { seq: 0, type: 'session/end-seed', data: {} },
  { seq: 1, type: 'turn/start', data: { turn: 1 } },
  { seq: 2, type: 'user/message', data: { role: 'user', content: msg('先看一下这个仓库的结构') } },
  { seq: 3, type: 'assistant/message', data: { turn: 1, message: { id: 'm1', role: 'assistant', content: msg('仓库有两个包。') } } },
  { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  { seq: 5, type: 'turn/start', data: { turn: 2 } },
  { seq: 6, type: 'user/message', data: { role: 'user', content: msg('把刚才那个报错修一下') } },
  { seq: 7, type: 'assistant/message', data: { turn: 2, message: { id: 'm2', role: 'assistant', content: msg('已修复。') } } },
  { seq: 8, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  { seq: 9, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-v4' } },
];

const messages = collectMessages(events);
assert.equal(messages.length, 4);
assert.equal(messages[0].role, 'user');
assert.equal(messages[1].role, 'assistant');

const anchor = locateDraft(messages, '把刚才那个报错修一下');
assert.equal(anchor, 2);
assert.equal(locateDraft(messages, '完全新的问题'), -1);

const context = buildContext(messages, anchor, { historyMessages: 6, historyChars: 4000, messageChars: 700 });
assert.ok(context.text.includes('把刚才那个报错修一下'));
assert.ok(context.text.includes('the draft below repeats this message'));
assert.ok(context.used >= 2);

const route = resolveRoute({ get: () => undefined }, events);
assert.deepEqual(route, { provider: 'deepseek', model: 'deepseek-v4' });

assert.equal(textOf(msg('a')), 'a');
assert.equal(textOf([{ type: 'reasoning', text: 'x' }, { type: 'text', text: 'b' }]), 'b');

assert.equal(sanitizeResult('  hello  '), 'hello');
assert.equal(sanitizeResult('```markdown\nhello\n```'), 'hello');
assert.equal(sanitizeResult('Rewritten prompt: hello there'), 'hello there');
assert.equal(sanitizeResult('优化后的提示词：你好'), '你好');
assert.equal(sanitizeResult('"hello"'), 'hello');
assert.equal(sanitizeResult(''), '');

const cfg = readConfig({ maxDraftChars: 10, historyMessages: 999 });
assert.equal(cfg.maxDraftChars, 200);
assert.equal(cfg.historyMessages, 24);
assert.equal(cfg.maxOutputTokens, 8192);
assert.equal(cfg.systemPrompt, DEFAULT_SYSTEM_PROMPT);

assert.equal(outputBudget(10, 8192), 1024);
assert.equal(outputBudget(100, 8192), 1024);
assert.equal(outputBudget(3000, 8192), 2956);
assert.equal(outputBudget(8000, 8192), 7456);
assert.equal(outputBudget(8000, 2048), 2048);
assert.equal(outputBudget(10, 512), 512);
assert.equal(readConfig(null).includeContext, true);
assert.equal(readConfig({ includeContext: false }).includeContext, false);

const input = buildInput('draft text', { text: 'ctx line', used: 1 }, 'D:\\work');
assert.ok(input.indexOf('<conversation_context>') < input.indexOf('<draft>'));
assert.ok(input.includes('<cwd>D:\\work</cwd>'));
assert.ok(input.trimEnd().endsWith('Rewrite the draft now.'));

console.log('all host unit checks passed');
